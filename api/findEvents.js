// api/findEvents.js - DESPACHADOR (VERSIÓN OPTIMIZADA)

require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

async function dispatchJobs() {
    console.log("🚀 Iniciando Despachador Optimizado...");
    const client = new MongoClient(mongoUri);

    const baseUrl = (process.env.VERCEL_URL && !process.env.VERCEL_URL.startsWith('localhost'))
        ? `https://${process.env.VERCEL_URL}`
        : `http://localhost:3000`;
    const workerUrl = `${baseUrl}/api/processArtist`;
    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

    try {
        await client.connect();
        const database = client.db(dbName);
        const artistsCollection = database.collection(artistsCollectionName);

        const ARTIST_DAILY_LIMIT = 30;
        const artistsToSearch = await artistsCollection.find({}).sort({ lastScrapedAt: 1 }).limit(ARTIST_DAILY_LIMIT).toArray();

        if (artistsToSearch.length === 0) {
            console.log("No hay artistas en la cola para procesar.");
            return;
        }

        console.log(`📨 Despachando ${artistsToSearch.length} tareas...`);

        // --- INICIO DE LA OPTIMIZACIÓN ---

        // 1. Lanzamos todas las llamadas a los trabajadores en paralelo
        const dispatchPromises = artistsToSearch.map(artist => {
            return axios.post(workerUrl, { artist }, {
                headers: { 'x-vercel-protection-bypass': bypassSecret }
            }).catch(error => {
                // El log de error ya es detallado, lo mantenemos
                console.error(`❌ Error al despachar tarea para ${artist.name}. Status: ${error.response?.status}`);
            });
        });

        // 2. Preparamos UNA SOLA actualización masiva para la base de datos
        const artistIdsToUpdate = artistsToSearch.map(a => a._id);
        const updatePromise = artistsCollection.updateMany(
            { _id: { $in: artistIdsToUpdate } },
            { $set: { lastScrapedAt: new Date() } }
        );
        console.log(`...y preparando la actualización de ${artistIdsToUpdate.length} artistas en la BD.`);

        // 3. Esperamos a que todo termine (llamadas y la única actualización a la BD)
        await Promise.all([...dispatchPromises, updatePromise]);

        // --- FIN DE LA OPTIMIZACIÓN ---

        console.log("✅ Despacho y actualización de BD completados con éxito.");

    } catch (error) {
        console.error("💥 Error fatal en el Despachador Optimizado:", error);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

// --- Handler para Vercel (Sin cambios) ---
module.exports = async (req, res) => {
    await dispatchJobs();
    res.status(202).send('Despacho de tareas completado.');
};
