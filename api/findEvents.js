// api/findEvents.js - DESPACHADOR CON VERCELL KV
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { kv } = require('@vercel/kv'); // <-- CAMBIO CLAVE: Usamos el cliente oficial de Vercel KV

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

async function queueJobs() {
    console.log("🚀 Iniciando Despachador para encolar tareas con Vercel KV...");
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const artists = db.collection(artistsCollectionName);
        const artistsToSearch = await artists.find({}).sort({ lastScrapedAt: 1 }).limit(30).toArray();

        if (artistsToSearch.length > 0) {
            console.log(`📨 Añadiendo ${artistsToSearch.length} artistas a la cola...`);
            const artistPayloads = artistsToSearch.map(artist => JSON.stringify(artist));
            await kv.lpush('artist-queue', ...artistPayloads); // <-- CAMBIO: Usamos kv.lpush

            const idsToUpdate = artistsToSearch.map(a => a._id);
            await artists.updateMany({ _id: { $in: idsToUpdate } }, { $set: { lastScrapedAt: new Date() } });

            console.log("✅ Artistas encolados y actualizados.");
        }
    } finally {
        await client.close();
    }
}

module.exports = async (req, res) => {
    try {
        await queueJobs();
        res.status(200).send('Proceso de encolado completado.');
    } catch (error) {
        console.error('Error en el despachador:', error);
        res.status(500).send('Error interno del servidor.');
    }
};
