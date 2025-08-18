// api/findEvents.js - DESPACHADOR CON CONEXIÓN ROBUSTA
require('dotenv').config();
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// --- CAMBIO: Creamos el cliente de Redis FUERA del handler ---
const redis = new Redis(process.env.REDIS_URL);
console.log("Redis client initialized.");

async function queueJobs() {
    console.log("🚀 Iniciando Despachador para encolar tareas...");
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const db = client.db(dbName);
        const artists = db.collection(artistsCollectionName);
        const artistsToSearch = await artists.find({}).sort({ lastScrapedAt: 1 }).limit(30).toArray();

        if (artistsToSearch.length > 0) {
            console.log(`📨 Añadiendo ${artistsToSearch.length} artistas a la cola...`);
            const artistPayloads = artistsToSearch.map(artist => JSON.stringify(artist));
            await redis.lpush('artist-queue', ...artistPayloads);

            const idsToUpdate = artistsToSearch.map(a => a._id);
            await artists.updateMany({ _id: { $in: idsToUpdate } }, { $set: { lastScrapedAt: new Date() } });

            console.log("✅ Artistas encolados y actualizados.");
        }
    } finally {
        await client.close();
        // --- CAMBIO CLAVE: NO LLAMAMOS A redis.quit() AQUÍ ---
        // Dejamos la conexión abierta para que Vercel la reutilice.
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
