const express = require('express');
const router = express.Router();
const { checkConfig, getSupabaseAdminClient } = require('../config/env');
const { checkPaymentLimiter } = require('../config/rate-limiters');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { getCheckoutSession } = require('../services/saspay');
const { createOrderFromEscrow } = require('../services/escrow');
const { isUnderpaid, confirmMonetizationOnce } = require('../services/monetization');

const STATUS_MAP = {
  pending: 'pending',
  funded: 'paid',
  released: 'paid',
  cancelled: 'failure',
  failed: 'failure',
  confirmed: 'paid',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vérifier le statut d'un paiement (MoneyFusion & SasPay transparent)
router.get('/check-payment', checkPaymentLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const transactionId = req.query.transactionId || req.query.txid || req.query.token;
    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transactionId requis' });
    }

    // 1. Chercher d'abord dans escrow_transactions
    let { data: escrow } = await supabase
      .from('escrow_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (!escrow) {
      const { data: escrowByRef } = await supabase
        .from('escrow_transactions')
        .select('*')
        .eq('payment_reference', transactionId)
        .maybeSingle();
      escrow = escrowByRef;
    }

    if (escrow) {
      if (escrow.status !== 'pending') {
        return res.json({
          success: true,
          status: STATUS_MAP[escrow.status] || 'unknown',
          transactionId: escrow.id,
          order_id: escrow.order_id || null,
          amount: escrow.total_amount,
          paymentMethod: escrow.payment_method,
          confirmedAt: escrow.funded_at,
        });
      }

      if (escrow.payment_reference) {
        const token = escrow.payment_reference;
        const isSasPay = UUID_RE.test(token);

        if (isSasPay) {
          // Vérification SasPay
          try {
            const session = await getCheckoutSession(token);
            const isPaid = session && (session.status === 'PAID' || session.transaction_status === 'SUCCESS' || session.status === 'SUCCESS');
            if (isPaid) {
              console.log('check-payment: SasPay confirmed, creating order...');
              const orderId = await createOrderFromEscrow(supabase, escrow, null);
              return res.json({
                success: true,
                status: 'paid',
                transactionId: escrow.id,
                order_id: orderId,
                amount: escrow.total_amount,
                paymentMethod: 'mobile_money',
                confirmedAt: new Date().toISOString(),
              });
            }
            if (session && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(session.status)) {
              await supabase.from('escrow_transactions').update({ status: 'cancelled' }).eq('id', escrow.id);
              return res.json({ success: true, status: 'failure', transactionId: escrow.id });
            }
          } catch (sasErr) {
            console.log('check-payment: SasPay check failed:', sasErr.message);
          }
        } else {
          // Vérification MoneyFusion
          try {
            const fusionData = await checkPaymentNotification(token);
            if (fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid') {
              if (isUnderpaid(fusionData, escrow.total_amount)) {
                return res.json({ success: true, status: 'pending', transactionId: escrow.id, amount: escrow.total_amount });
              }
              console.log('check-payment: MoneyFusion confirmed, creating order...');
              const orderId = await createOrderFromEscrow(supabase, escrow, null);
              return res.json({
                success: true,
                status: 'paid',
                transactionId: escrow.id,
                order_id: orderId,
                amount: escrow.total_amount,
                paymentMethod: escrow.payment_method,
                confirmedAt: new Date().toISOString(),
              });
            }
            if (fusionData && fusionData.data?.statut === 'failure') {
              await supabase.from('escrow_transactions').update({ status: 'cancelled' }).eq('id', escrow.id);
              return res.json({ success: true, status: 'failure', transactionId: escrow.id });
            }
          } catch (fusionErr) {
            console.log('check-payment: MoneyFusion check failed:', fusionErr.message);
          }
        }
      }

      return res.json({
        success: true,
        status: 'pending',
        transactionId: escrow.id,
        amount: escrow.total_amount,
        paymentMethod: escrow.payment_method,
      });
    }

    // 2. Chercher dans monetization_transactions
    let { data: tx } = await supabase
      .from('monetization_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (!tx) {
      const { data: txByRef } = await supabase
        .from('monetization_transactions')
        .select('*')
        .eq('provider_token', transactionId)
        .maybeSingle();
      tx = txByRef;
    }

    if (tx) {
      if (tx.status !== 'pending') {
        return res.json({
          success: true,
          status: STATUS_MAP[tx.status] || 'unknown',
          transactionId: tx.id,
          amount: tx.amount,
          confirmedAt: tx.confirmed_at,
        });
      }

      if (tx.provider_token) {
        const token = tx.provider_token;
        const isSasPay = UUID_RE.test(token);

        if (isSasPay) {
          try {
            const session = await getCheckoutSession(token);
            const isPaid = session && (session.status === 'PAID' || session.transaction_status === 'SUCCESS' || session.status === 'SUCCESS');
            if (isPaid) {
              await confirmMonetizationOnce(supabase, tx);
              return res.json({
                success: true,
                status: 'paid',
                transactionId: tx.id,
                amount: tx.amount,
                confirmedAt: new Date().toISOString(),
              });
            }
            if (session && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(session.status)) {
              await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', tx.id);
              return res.json({ success: true, status: 'failure', transactionId: tx.id });
            }
          } catch (sasErr) {
            console.log('check-payment: SasPay monetization check failed:', sasErr.message);
          }
        } else {
          try {
            const fusionData = await checkPaymentNotification(token);
            if (fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid') {
              if (isUnderpaid(fusionData, tx.amount)) {
                return res.json({ success: true, status: 'pending', transactionId: tx.id, amount: tx.amount });
              }
              await confirmMonetizationOnce(supabase, tx);
              return res.json({
                success: true,
                status: 'paid',
                transactionId: tx.id,
                amount: tx.amount,
                confirmedAt: new Date().toISOString(),
              });
            }
            if (fusionData && fusionData.data?.statut === 'failure') {
              await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', tx.id);
              return res.json({ success: true, status: 'failure', transactionId: tx.id });
            }
          } catch (fusionErr) {
            console.log('check-payment: MoneyFusion check failed:', fusionErr.message);
          }
        }
      }

      return res.json({
        success: true,
        status: tx.status,
        transactionId: tx.id,
        amount: tx.amount,
      });
    }

    return res.status(404).json({ success: false, message: 'Transaction introuvable', status: 'unknown' });
  } catch (e) {
    console.error('ERROR /check-payment:', e.message || e);
    return res.status(500).json({ success: false, message: e.message, status: 'unknown' });
  }
});

module.exports = router;
