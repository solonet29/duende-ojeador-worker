// api/findEvents.js - EL DESPACHADOR (CON DEPURACIÓN MEJORADA)

require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// --- Lógica del Despachador ---
async function dispatchJobs() {
    console.log("🚀 Iniciando Despachador para distribuir tareas de búsqueda de eventos...");
    const client = new MongoClient(mongoUri);

    // CONSTRUIMOS LA URL COMPLETA. Asegurándonos de que tenga el protocolo correcto.
    const baseUrl = (process.env.VERCEL_URL && !process.env.VERCEL_URL.startsWith('localhost'))
        ? `https://${process.env.VERCEL_URL}`
        : `http://localhost:3000`;
    const workerUrl = `${baseUrl}/api/processArtist`;

    // --- NUEVO LOG ---
    console.log(`📡 URL del trabajador configurada: ${workerUrl}`);

    try {
        await client.connect();
        const database = client.db(dbName);
        const artistsCollection = database.collection(artistsCollectionName);

        const ARTIST_DAILY_LIMIT = 30;
        const artistsToSearch = await artistsCollection.find({}).sort({ lastScrapedAt: 1 }).limit(ARTIST_DAILY_LIMIT).toArray();

        if (artistsToSearch.length === 0) {
            console.log("No hay artistas en la cola para procesar. Misión cumplida por ahora.");
            return;
        }

        console.log(`📨 Despachando ${artistsToSearch.length} tareas a los trabajadores...`);

        const dispatchPromises = artistsToSearch.map(artist => {
            return axios.post(workerUrl, { artist })
                .then(() => {
                    return artistsCollection.updateOne({ _id: artist._id }, { $set: { lastScrapedAt: new Date() } });
                })
                .catch(error => {
                    // --- LOG DE ERROR MEJORADO ---
                    console.error(`❌ Error al despachar tarea para ${artist.name}.`);
                    if (error.response) {
                        // Si hay una respuesta del servidor (ej: error 404, 500)
                        console.error('Data:', error.response.data);
                        console.error('Status:', error.response.status);
                    } else if (error.request) {
                        // Si la petición se hizo pero no hubo respuesta
                        console.error('Request Error. No hubo respuesta del trabajador.');
                    } else {
                        // Otro tipo de error
                        console.error('Error:', error.message);
                    }
                });
        });

        await Promise.all(dispatchPromises);
        console.log("✅ Todas las tareas han sido despachadas.");

    } catch (error) {
        console.error("💥 Error fatal en el Despachador:", error);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

// --- Handler para Vercel ---
module.exports = async (req, res) => {
    // Ejecutamos la lógica de despacho en segundo plano.
    await dispatchJobs();

    // Respondemos inmediatamente al Cron Job con "202-Accepted".
    // Esto le dice a Vercel: "He recibido tu orden y ya me he puesto a trabajar".
    res.status(202).send('Despacho de tareas iniciado.');
};
