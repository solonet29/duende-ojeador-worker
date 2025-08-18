// api/processArtist.js - TRABAJADOR DE COLA
require('dotenv').config();
const { kv } = require('@vercel/kv');
// ... (mantén el resto de tus requires y funciones de utilidad: MongoClient, axios, Gemini, etc.)

// ... (mantén la función processSingleArtist que ya tenías)
async function processSingleArtist(artist) { /* ...el código que ya tienes... */ }

async function processQueue() {
    console.log("👷 Trabajador de cola iniciado. Buscando tareas...");
    // RPOP saca el último artista de la lista. Si no hay, devuelve null.
    const artist = await kv.rpop('artist-queue');

    if (artist) {
        console.log(`📬 Tarea recibida. Procesando al artista: ${artist.name}`);
        await processSingleArtist(artist);
        console.log(`✅ Tarea para ${artist.name} completada.`);
    } else {
        console.log("📪 No hay tareas en la cola. El trabajador se va a dormir.");
    }
}

module.exports = async (req, res) => {
    await processQueue();
    res.status(200).send('Ciclo del trabajador de cola completado.');
};