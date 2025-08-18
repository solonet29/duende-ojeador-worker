// api/processArtist.js - TRABAJADOR CON CONEXIÓN CORREGIDA
require('dotenv').config();
const Redis = require('ioredis');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

// --- CAMBIO CLAVE: Usamos la variable de entorno correcta de Vercel ---
// Ahora se llama STORAGE_REDIS_URL, no REDIS_URL
const redis = new Redis(process.env.STORAGE_REDIS_URL);
redis.on('error', (err) => {
    console.error('Redis error en el trabajador:', err);
});

// Funciones de utilidad y lógica de procesamiento...
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function processSingleArtist(artist) {
    console.log(`Buscando eventos para ${artist.name}...`);
    // ... (Tu lógica para llamar a Google Search, Gemini, etc.)
    // ... (Tu lógica para insertar en la base de datos temporal)

    // Aquí puedes dejar el resto de tu código tal como lo tenías.
    // Solo se ha modificado la gestión de la conexión.

    // --- Lógica simulada de tu función ---
    return new Promise(resolve => {
        setTimeout(() => {
            console.log(`Simulando el procesamiento de ${artist.name}.`);
            resolve();
        }, 2000);
    });
}

async function processQueue() {
    console.log("👷 Trabajador iniciado. Buscando tareas...");
    // Usamos rpop para obtener una tarea de la cola
    const artistString = await redis.rpop('artist-queue');

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
        res.status(500).send('Error interno del servidor.');
    }
};