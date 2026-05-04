#!/usr/bin/env node
/**
 * scripts/migrar-cavalos.js
 * 
 * K1 — Script de migração: unifica a collection "clientes" (cavalos cadastrados
 * pelos vets) com a collection "cavalos" (cadastrados pelo Portal do Proprietário).
 * 
 * ATENÇÃO: NÃO execute este script sem antes fazer backup completo do Firestore.
 * 
 * ESTRATÉGIA: migrar tudo para "clientes", pois é onde há mais código e queries.
 * Os documentos de "cavalos" serão copiados para "clientes" com campo-mapeamento.
 * 
 * COMO RODAR:
 *   1. Faça backup do Firestore: Firebase Console > Firestore > Export
 *   2. Configure a variável GOOGLE_APPLICATION_CREDENTIALS:
 *      export GOOGLE_APPLICATION_CREDENTIALS="./serviceAccountKey.json"
 *   3. Execute: node scripts/migrar-cavalos.js --dry-run
 *   4. Revise o output. Se OK: node scripts/migrar-cavalos.js
 */

const admin = require('firebase-admin');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}

try {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
} catch (e) {
    if (!e.message.includes('already exists')) throw e;
}

const db = admin.firestore();

async function migrar() {
    console.log(`\n🐴 HorseSmart — Migração de Cavalos (${DRY_RUN ? 'DRY RUN' : 'EXECUÇÃO REAL'})\n`);

    const cavalosSnap = await db.collection('cavalos').get();
    console.log(`Documentos encontrados em "cavalos": ${cavalosSnap.size}`);

    let migrados = 0;
    let ignorados = 0;
    let erros = 0;

    for (const docSnap of cavalosSnap.docs) {
        const cavalo = docSnap.data();
        const id = docSnap.id;

        // Verificar se já existe em "clientes" com mesmo id
        const existeEmClientes = await db.collection('clientes').doc(id).get();
        if (existeEmClientes.exists) {
            console.log(`  IGNORADO (já existe em clientes): ${id}`);
            ignorados++;
            continue;
        }

        // Mapear campos de "cavalos" para formato "clientes"
        const novoDoc = {
            // Campos comuns
            nome_cavalo: cavalo.nome || cavalo.nome_cavalo || 'Sem nome',
            nome_proprietario: cavalo.nome_proprietario || '',
            cpf_cnpj: cavalo.cpf || cavalo.cpf_cnpj || '',
            telefone_proprietario: cavalo.telefone || cavalo.telefone_proprietario || '',

            // Campos de vínculo
            userId: cavalo.userId || '',
            uidProprietario: cavalo.uidProprietario || '',

            // Origem da migração
            _migradoDe: 'cavalos',
            _migradoEm: admin.firestore.FieldValue.serverTimestamp(),
            _idOriginal: id,

            // Preservar campos extras
            ...cavalo
        };

        if (DRY_RUN) {
            console.log(`  [DRY RUN] Migraria cavalos/${id} → clientes/${id}`);
            console.log(`    nome_cavalo: ${novoDoc.nome_cavalo}`);
            console.log(`    userId: ${novoDoc.userId}`);
            console.log(`    uidProprietario: ${novoDoc.uidProprietario}`);
        } else {
            try {
                await db.collection('clientes').doc(id).set(novoDoc);
                console.log(`  ✓ Migrado: cavalos/${id} → clientes/${id}`);
                migrados++;
            } catch (err) {
                console.error(`  ✗ ERRO ao migrar ${id}:`, err.message);
                erros++;
            }
        }

        if (DRY_RUN) migrados++;
    }

    console.log(`\n────────────────────────────────────`);
    console.log(`Migrados:  ${migrados}`);
    console.log(`Ignorados: ${ignorados}`);
    console.log(`Erros:     ${erros}`);

    if (!DRY_RUN && migrados > 0) {
        console.log(`\n⚠️  PRÓXIMOS PASSOS:`);
        console.log(`  1. Verificar os documentos migrados em Firestore Console`);
        console.log(`  2. Atualizar as regras do Firestore (já atualizado em firestore.rules)`);
        console.log(`  3. Após validação, excluir a collection "cavalos" manualmente`);
        console.log(`     (NÃO excluir sem conferir que todos os dados estão em "clientes")`);
    }

    console.log(`\n✅ Concluído (${DRY_RUN ? 'dry run' : 'real'}).\n`);
    process.exit(0);
}

migrar().catch(err => {
    console.error('Erro fatal na migração:', err);
    process.exit(1);
});
