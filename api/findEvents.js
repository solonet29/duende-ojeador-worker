// api/findEvents.js - DESPACHADOR CON CONEXIÓN CORREGIDA
require('dotenv').config();
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// --- CAMBIO CLAVE: Usamos la variable de entorno correcta de Vercel ---
// Ahora se llama STORAGE_REDIS_URL, no REDIS_URL
const redis = new Redis(process.env.STORAGE_REDIS_URL);
redis.on('error', (err) => {
    console.error('Redis error en el despachador:', err);
});

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
        } else {
            console.log("📪 No hay artistas para encolar en este momento.");
        }
    } finally {
        await client.close();
        // NOTA: No cerramos la conexión de Redis, Vercel la gestionará.
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
