require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio'); 
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN Y CONEXIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas: MONGO_URI, GOOGLE_API_KEY o GOOGLE_CX.');
}

// --- LÓGICA PRINCIPAL ---
async function main() {
    const client = new MongoClient(mongoUri);
    try {
        await client.connect();
        const database = client.db("DuendeDB");
        console.log("Conectado a la base de datos.");

        // --- MEJORA 1: Obtener la lista completa de artistas ---
        const uniqueArtists = await getAllArtists(database);
        console.log(`Se ha compilado una lista de ${uniqueArtists.length} artistas únicos para buscar.`);

        console.log("\n--- Generando y realizando búsquedas ---");

        let scrapedEvents = [];
        for (const artist of uniqueArtists) {
            if (!artist) continue; // Saltar artistas nulos o vacíos
            const queries = generateQueries(artist);
            console.log(`\nBuscando para '${artist}'...`);
            
            for (const query of queries) {
                const searchResults = await searchGoogle(query);
                const relevantLinks = processSearchResults(searchResults);
                
                if (relevantLinks.length > 0) {
                    console.log(` -> Enlaces relevantes encontrados para '${query}': ${relevantLinks.length}`);
                    for (const link of relevantLinks) {
                        try {
                            const eventData = await scrapeEventPage(link, artist);
                            if (eventData) {
                                // Aseguramos que siempre trabajamos con un array
                                const eventsArray = Array.isArray(eventData) ? eventData : [eventData];
                                if (eventsArray.length > 0) {
                                    console.log(`  -> Datos extraídos de ${link}:`, eventsArray.length, 'eventos.');
                                    scrapedEvents.push(...eventsArray);
                                }
                            }
                        } catch (e) {
                            console.error(`  -> Error al procesar el enlace ${link}:`, e.message);
                        }
                    }
                }
            }
        }
        
        console.log("\n--- Proceso finalizado ---");
        // Filtramos eventos duplicados por un identificador único (ej: artista + fecha + ciudad)
        const uniqueEvents = Array.from(new Map(scrapedEvents.map(e => [`${e.artist}-${e.date}-${e.city}`, e])).values());
        
        await saveEventsToJson(uniqueEvents, 'nuevos_eventos.json');
        
    } catch (error) {
        console.error("Error al ejecutar el Ojeador:", error);
    } finally {
        await client.close();
        console.log("Conexión a la base de datos cerrada.");
    }
}

// --- FUNCIÓN MEJORADA PARA OBTENER ARTISTAS ---
async function getAllArtists(db) {
    const artistsCollection = db.collection('artists');
    const eventsCollection = db.collection('events');
    const artistNames = new Set();

    // 1. Obtener artistas de la colección 'artists'
    try {
        const artistsFromCollection = await artistsCollection.find({}, { projection: { name: 1 } }).toArray();
        artistsFromCollection.forEach(artist => artist.name && artistNames.add(artist.name.trim()));
    } catch (e) {
        console.warn("Advertencia: No se pudo leer la colección 'artists'. Puede que no exista todavía.", e.message);
    }

    // 2. Obtener artistas de la colección 'events'
    try {
        const artistsFromEvents = await eventsCollection.distinct('artist');
        artistsFromEvents.forEach(artistName => artistName && artistNames.add(artistName.trim()));
    } catch (e) {
        console.error("Error crítico: No se pudo leer la colección 'events'.", e.message);
        return []; // Devolvemos un array vacío si no podemos leer los eventos
    }
    
    // Convertimos a un formato unificado (Capitalizamos cada palabra)
    return Array.from(artistNames).map(name => name.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()));
}


// --- FUNCIÓN QUE GENERA CONSULTAS BASADA EN REGLAS ---
function generateQueries(artistName) {
    const templates = [
        `conciertos ${artistName} España`,
        `gira ${artistName} fechas`,
        `eventos ${artistName} entradas`,
    ];
    return templates;
}

// --- FUNCIÓN QUE REALIZA LAS BÚSQUEDAS EN GOOGLE ---
async function searchGoogle(query) {
    const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(query)}`;
    try {
        const response = await axios.get(url);
        return response.data.items || []; 
    } catch (error) {
        console.error(`Error al buscar en Google para la consulta '${query}':`, error.response ? error.response.data : error.message);
        return [];
    }
}

// --- FUNCIÓN QUE PROCESA LOS RESULTADOS DE BÚSQUEDA ---
function processSearchResults(results) {
    const relevantLinks = [];
    const keywords = ['conciertos', 'evento', 'gira', 'tickets', 'entradas', 'agenda'];
    const exclusionList = ['wikipedia.org', 'facebook.com', 'twitter.com', 'pinterest.com', 'instagram.com', 'youtube.com'];

    if (!results || results.length === 0) {
        return relevantLinks;
    }

    for (const item of results) {
        const link = item.link;
        const title = item.title.toLowerCase();
        const isExcluded = exclusionList.some(excludedDomain => link.includes(excludedDomain));
        if (isExcluded) continue;

        const isRelevant = keywords.some(keyword => title.includes(keyword) || link.includes(keyword));
        if (isRelevant) {
            relevantLinks.push(link);
        }
    }
    return [...new Set(relevantLinks)]; // Devolvemos solo enlaces únicos
}

// --- FUNCIÓN QUE VISITA EL ENLACE Y EXTRAE LOS DATOS (MEJORADA) ---
async function scrapeEventPage(url, originalArtistName) {
    // Definimos aquí las palabras clave para el sistema de puntuación
    const positiveKeywords = ['flamenco', 'cante', 'toque', 'baile', 'jondo', 'compás', 'tablao', 'peña', 'guitarra', 'festival'];
    const negativeKeywords = ['pop', 'rock', 'clases de zumba', 'orquesta sinfónica', 'jazz', 'latino'];

    let eventData = null; // Inicializamos como null

    // Lógica de Scraping para cada web
    if (url.includes('expoflamenco.com/agenda/eventos')) {
        // ... tu lógica de scraping para expoflamenco ...
    } else if (url.includes('entradas.ibercaja.es/')) {
        // ... tu lógica de scraping para ibercaja ...
    } else if (url.includes('holayadioslagira.es/')) {
        // ... tu lógica de scraping para holayadioslagira ...
    } else {
        return null; // Si la URL no es de un scraper conocido, no hacemos nada
    }

    // Si el scraping devolvió datos, los procesamos con el sistema de puntuación
    if (eventData) {
        const eventsArray = Array.isArray(eventData) ? eventData : [eventData];
        const acceptedEvents = [];

        for (const event of eventsArray) {
            const textToAnalyze = `${event.title} ${event.artist} ${event.description || ''}`.toLowerCase();
            let score = 0;
            positiveKeywords.forEach(keyword => { if (textToAnalyze.includes(keyword)) score++; });
            negativeKeywords.forEach(keyword => { if (textToAnalyze.includes(keyword)) score--; });

            if (score > 0) {
                acceptedEvents.push(event);
            }
        }
        return acceptedEvents; // Devolvemos el array de eventos aceptados
    }
    
    return null;
}

// --- FUNCIÓN PARA OBTENER LA PROVINCIA A PARTIR DE LA CIUDAD ---
function getProvinciaByCity(city) {
    const cityMap = {
        'Sevilla': 'Sevilla',
        'Barcelona': 'Barcelona',
        'Zaragoza': 'Zaragoza',
        'Madrid': 'Madrid',
        'Úbeda': 'Jaén',
        'A Coruña': 'A Coruña',
        'Córdoba': 'Córdoba',
        'Huelva': 'Huelva'
    };
    return cityMap[city] || city;
}

// --- FUNCIÓN PARA COMPROBAR SI UNA URL ES UNA IMAGEN ---
function isImageUrl(url) {
    return /\.(jpeg|jpg|gif|png)$/.test(url.toLowerCase());
}

// --- FUNCIÓN PARA GUARDAR LOS EVENTOS EN UN ARCHIVO JSON ---
async function saveEventsToJson(events, filename) {
    if (events.length === 0) {
        console.log("No se encontraron eventos nuevos para guardar.");
        const emptyStructure = { artistas: [], salas: [], eventos: [] };
        fs.writeFileSync(filename, JSON.stringify(emptyStructure, null, 2), 'utf8');
        return;
    }
    
    // Creamos la estructura final que espera el Ingesta-Worker
    const finalJsonObject = {
        artistas: [], // Por ahora no extraemos artistas/salas nuevos, solo eventos
        salas: [],
        eventos: events.map(ev => ({
            id: `${(ev.artist || '').toLowerCase().replace(/ /g, '-')}-${(ev.city || '').toLowerCase().replace(/ /g, '-')}-${ev.date}`,
            name: ev.title,
            artist: ev.artist,
            description: ev.description || '',
            date: ev.date, // Idealmente, este campo debería estar en formato YYYY-MM-DD
            time: ev.time || '',
            venue: ev.venue,
            city: ev.city,
            provincia: ev.provincia,
            country: ev.country,
            verified: ev.verified || false,
            sourceURL: ev.source 
        }))
    };
    
    try {
        const jsonData = JSON.stringify(finalJsonObject, null, 2);
        fs.writeFileSync(filename, jsonData, 'utf8');
        console.log(`Se han guardado ${events.length} eventos en '${filename}' con el formato correcto.`);
    } catch (error) {
        console.error(`Error al escribir el archivo JSON '${filename}':`, error);
    }
}

main();