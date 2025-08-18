// api/findEvents.js - DESPACHADOR CON CONEXIÓN DIRECTA
require('dotenv').config();
const { MongoClient } = require('mongodb');
const Redis = require('ioredis'); // <-- CAMBIO: Nueva librería

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// --- CAMBIO: Creamos el cliente de Redis directamente con la URL que sí tenemos ---
const redis = new Redis(process.env.REDIS_URL);

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
            // CAMBIO: Usamos redis.lpush en lugar de kv.lpush
            // Tenemos que convertir los objetos a string para guardarlos
            const artistPayloads = artistsToSearch.map(artist => JSON.stringify(artist));
            await redis.lpush('artist-queue', ...artistPayloads);

            const idsToUpdate = artistsToSearch.map(a => a._id);
            await artists.updateMany({ _id: { $in: idsToUpdate } }, { $set: { lastScrapedAt: new Date() } });

            console.log("✅ Artistas encolados y actualizados.");
        }
    } finally {
        await client.close();
        await redis.quit(); // Cerramos la conexión de Redis
    }
}

module.exports = async (req, res) => {
    await queueJobs();
    res.status(200).send('Proceso de encolado completado.');
};
