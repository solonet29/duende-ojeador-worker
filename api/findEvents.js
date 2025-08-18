// api/findEvents.js - EL DESPACHADOR (EL "JEFE")

require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

// --- Configuración ---
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME || 'DuendeDB';
const artistsCollectionName = 'artists';

// La URL de nuestro nuevo trabajador. Vercel nos da la URL base del despliegue.
// Es importante que el proyecto tenga un dominio asignado o usar la URL de vercel.app
const workerUrl = `https://${process.env.VERCEL_URL}/api/processArtist`;

// --- Lógica del Despachador ---
async function dispatchJobs() {
    console.log("🚀 Iniciando Despachador para distribuir tareas de búsqueda de eventos...");
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        const database = client.db(dbName);
        const artistsCollection = database.collection(artistsCollectionName);

        const ARTIST_DAILY_LIMIT = 30;
        const artistsToSearch = await artistsCollection
            .find({})
            .sort({ lastScrapedAt: 1 })
            .limit(ARTIST_DAILY_LIMIT)
            .toArray();

        if (artistsToSearch.length === 0) {
            console.log("No hay artistas en la cola para procesar. Misión cumplida por ahora.");
            return;
        }

        console.log(`📨 Despachando ${artistsToSearch.length} tareas a los trabajadores...`);

        // Creamos un array de promesas para todas las llamadas a la API
        const dispatchPromises = artistsToSearch.map(artist => {
            // "Dispara y olvida": Enviamos la tarea al trabajador y no esperamos su respuesta.
            // El .catch() es para que un fallo al despachar no rompa todo el proceso.
            return axios.post(workerUrl, { artist })
                .then(() => {
                    // Actualizamos al artista inmediatamente después de despachar la tarea.
                    return artistsCollection.updateOne(
                        { _id: artist._id },
                        { $set: { lastScrapedAt: new Date() } }
                    );
                })
                .catch(error => {
                    console.error(`❌ Error al despachar tarea para ${artist.name}: ${error.message}`);
                });
        });

        // Esperamos a que todas las tareas se hayan despachado
        await Promise.all(dispatchPromises);

        console.log("✅ Todas las tareas han sido despachadas con éxito.");

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
    dispatchJobs();

    // Respondemos inmediatamente al Cron Job con "202 Accepted".
    // Esto le dice a Vercel: "He recibido tu orden y ya me he puesto a trabajar".
    res.status(202).send('Despacho de tareas iniciado.');
};
