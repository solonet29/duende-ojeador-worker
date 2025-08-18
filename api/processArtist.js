// api/processArtist.js - TRABAJADOR CON VERCELL KV
require('dotenv').config();
const { kv } = require('@vercel/kv'); // <-- CAMBIO CLAVE: Usamos el cliente oficial de Vercel KV
// ... (mantén tus otros requires)

async function processSingleArtist(artist) { /* ...tu código sin cambios... */ }

async function processQueue() {
    console.log("👷 Trabajador iniciado. Buscando tareas...");
    const artistString = await kv.rpop('artist-queue'); // <-- CAMBIO: Usamos kv.rpop

    if (artistString) {
        const artist = JSON.parse(artistString);
        console.log(`📬 Tarea recibida. Procesando: ${artist.name}`);
        await processSingleArtist(artist);
        console.log(`✅ Tarea para ${artist.name} completada.`);
    } else {
        console.log("📪 No hay tareas en la cola.");
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
};