// api/processArtist.js - TRABAJADOR CON CONEXIÓN ROBUSTA
require('dotenv').config();
const Redis = require('ioredis');
// ... (mantén tus otros requires)

// --- CAMBIO: Creamos el cliente de Redis FUERA del handler ---
const redis = new Redis(process.env.REDIS_URL);
console.log("Redis client initialized.");

async function processSingleArtist(artist) { /* ...tu código sin cambios... */ }

async function processQueue() {
    console.log("👷 Trabajador iniciado. Buscando tareas...");
    // CAMBIO CLAVE: Usamos redis.brpop para esperar nuevas tareas
    // Si la cola está vacía, se queda esperando 5 minutos (300 segundos)
    const [queueName, artistString] = await redis.brpop('artist-queue', 300);

    if (artistString) {
        const artist = JSON.parse(artistString);
        console.log(`📬 Tarea recibida. Procesando: ${artist.name}`);
        await processSingleArtist(artist);
        console.log(`✅ Tarea para ${artist.name} completada.`);
    } else {
        console.log("📪 La cola de artistas ha estado vacía por 5 minutos. Terminando...");
    }
}

module.exports = async (req, res) => {
    try {
        await processQueue();
        res.status(200).send('Ciclo del trabajador completado.');
    } catch (error) {
        console.error('Error en el worker:', error);
        res.status(500).send('Error interno del trabajador.');
    }
    // --- CAMBIO CLAVE: NO LLAMAMOS A redis.quit() AQUÍ ---
    // Dejamos la conexión abierta para que Vercel la reutilice.
};