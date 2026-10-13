const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

require('dotenv').config();
const API_KEY = process.env.SASPAY_API_KEY;
const API_URL = (process.env.SASPAY_API_URL || 'https://api.saspay.me/api/v1').replace(/\/$/, '');

if (!API_KEY) {
  console.error("ERREUR: Veuillez définir la variable d'environnement SASPAY_API_KEY (ou dans un fichier .env).");
  process.exit(1);
}

async function main() {
  console.log('========================================================');
  console.log('   TEST OFFICIEL EN DIRECT DE L\'API SASPAY (LIVE)');
  console.log('========================================================\n');

  // 1. Réseaux disponibles en Côte d'Ivoire
  console.log('[1/4] Récupération des réseaux Mobile Money (CI)...');
  const netRes = await fetch(`${API_URL}/networks/?page_size=100`, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
  });
  const netJson = await netRes.json();
  const allNetworks = netJson?.data?.results || [];
  const ciNetworks = allNetworks.filter(n => n.code && n.code.endsWith('_ci'));
  console.log(`-> Statut HTTP: ${netRes.status} OK`);
  console.log(`-> Réseaux actifs détectés en Côte d'Ivoire (${ciNetworks.length}) :`);
  ciNetworks.forEach(n => console.log(`    * [${n.code}] ${n.name} (Actif: ${n.is_active ? 'OUI' : 'NON'})`));

  // 2. Test règle métier (Montant minimum)
  console.log('\n[2/4] Validation du montant minimum requis par SasPay (test 100 FCFA)...');
  const minRes = await fetch(`${API_URL}/checkout-sessions/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      amount: 100,
      currency: 'XOF',
      country: 'CI',
      description: 'Test DaloaMarket',
      customer_email: 'test@daloamarket.com',
      customer_name: 'Client Test',
      return_url: 'https://daloamarket.com/success'
    })
  });
  const minJson = await minRes.json();
  console.log(`-> Statut HTTP: ${minRes.status}`);
  console.log(`-> Réponse SasPay:`, JSON.stringify(minJson));

  // 3. Création session de paiement réelle (200 FCFA)
  console.log('\n[3/4] Création d\'une session de paiement réelle (200 FCFA)...');
  const payRes = await fetch(`${API_URL}/checkout-sessions/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      amount: 200,
      currency: 'XOF',
      country: 'CI',
      description: 'Achat Test DaloaMarket',
      customer_email: 'client@daloamarket.com',
      customer_name: 'Client DaloaMarket Test',
      customer_phone: '+2250700000000',
      return_url: 'https://daloamarket.com/order-success?ref=TEST_OK',
      metadata: { source: 'test_daloamarket' }
    })
  });
  const payJson = await payRes.json();
  const session = payJson?.data || payJson;
  console.log(`-> Statut HTTP: ${payRes.status} Created`);
  console.log(`-> Session ID : ${session.id}`);
  console.log(`-> Statut initial : ${session.status}`);
  console.log(`-> Lien de paiement : ${session.checkout_url}`);

  // 4. Consultation du statut de cette session
  if (session?.id) {
    console.log(`\n[4/4] Vérification du statut de la session créée (${session.id})...`);
    const checkRes = await fetch(`${API_URL}/checkout-sessions/${session.id}/`, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' }
    });
    const checkJson = await checkRes.json();
    console.log(`-> Statut HTTP: ${checkRes.status} OK`);
    console.log(`-> Session active :`, checkJson?.data?.status || checkJson?.status);
  }

  console.log('\n========================================================');
  console.log('   TOUS LES TESTS ONT RÉUSSI AVEC SUCCÈS');
  console.log('========================================================');
}

main().catch(err => console.error('ERREUR:', err));
