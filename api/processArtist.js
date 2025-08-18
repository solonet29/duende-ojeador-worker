// api/processArtist.js - TRABAJADOR CON CONEXIÓN DIRECTA
require('dotenv').config();
const Redis = require('ioredis'); // <-- CAMBIO: Nueva librería
// ... (mantén el resto de tus requires: MongoClient, axios, Gemini, etc.)

// --- CAMBIO: Creamos el cliente de Redis ---
const redis = new Redis(process.env.REDIS_URL);

// ... (mantén tus funciones de utilidad y la función processSingleArtist)
async function processSingleArtist(artist) { /* ...el código que ya tienes... */ }


async function processQueue() {
    console.log("👷 Trabajador iniciado. Buscando tareas...");
    // CAMBIO: Usamos redis.rpop
    const artistString = await redis.rpop('artist-queue');

    if (artistString) {
        const artist = JSON.parse(artistString); // Convertimos el string de vuelta a objeto
        console.log(`📬 Tarea recibida. Procesando: ${artist.name}`);
        await processSingleArtist(artist);
        console.log(`✅ Tarea para ${artist.name} completada.`);
    } else {
        console.log("📪 No hay tareas en la cola.");
    }
    await redis.quit(); // Cerramos la conexión de Redis
}

module.exports = async (req, res) => {
    await processQueue();
    res.status(200).send('Ciclo del trabajador completado.');
};