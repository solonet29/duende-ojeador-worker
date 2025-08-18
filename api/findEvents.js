// api/findEvents.js - EL DESPACHADOR (VERSIÓN FINAL)

require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// --- Lógica del Despachador ---
async function dispatchJobs() {
    console.log("🚀 Iniciando Despachador para distribuir tareas...");
    const client = new MongoClient(mongoUri);

    const baseUrl = (process.env.VERCEL_URL && !process.env.VERCEL_URL.startsWith('localhost'))
        ? `https://${process.env.VERCEL_URL}`
        : `http://localhost:3000`;
    const workerUrl = `${baseUrl}/api/processArtist`;

    // Obtenemos la credencial secreta de las variables de entorno
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

        console.log(`📨 Despachando ${artistsToSearch.length} tareas a los trabajadores...`);

        const dispatchPromises = artistsToSearch.map(artist => {
            // --- ¡AQUÍ ESTÁ LA MODIFICACIÓN CLAVE! ---
            // Añadimos la cabecera 'x-vercel-protection-bypass' a la llamada
            return axios.post(workerUrl, { artist }, {
                headers: {
                    'x-vercel-protection-bypass': bypassSecret
                }
            })
                .then(() => {
                    return artistsCollection.updateOne({ _id: artist._id }, { $set: { lastScrapedAt: new Date() } });
                })
                .catch(error => {
                    console.error(`❌ Error al despachar tarea para ${artist.name}.`);
                    if (error.response) {
                        console.error('Data:', error.response.data);
                        console.error('Status:', error.response.status);
                    } else {
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
    await dispatchJobs();
    res.status(202).send('Despacho de tareas completado.');
};
