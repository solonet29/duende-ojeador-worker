// api/findEvents.js - DESPACHADOR DE COLA
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { kv } = require('@vercel/kv');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

async function queueJobs() {
    console.log("🚀 Iniciando Despachador para encolar tareas...");
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const artists = db.collection(artistsCollectionName);

        const artistsToSearch = await artists.find({}).sort({ lastScrapedAt: 1 }).limit(30).toArray();

        if (artistsToSearch.length > 0) {
            console.log(`📨 Añadiendo ${artistsToSearch.length} artistas a la cola 'artist-queue'...`);
            // LPUSH añade todos los artistas a una lista en Vercel KV
            await kv.lpush('artist-queue', ...artistsToSearch);

            // Actualizamos su timestamp para no volver a cogerlos pronto
            const idsToUpdate = artistsToSearch.map(a => a._id);
            await artists.updateMany({ _id: { $in: idsToUpdate } }, { $set: { lastScrapedAt: new Date() } });

            console.log("✅ Artistas encolados y actualizados en la BD.");
        } else {
            console.log("No hay artistas para encolar.");
        }
    } finally {
        await client.close();
    }
}

module.exports = async (req, res) => {
    await queueJobs();
    res.status(200).send('Proceso de encolado de tareas completado.');
};
