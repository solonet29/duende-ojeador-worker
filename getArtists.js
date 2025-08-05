require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio'); 
const fs = require('fs');

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
        const artistsCollection = database.collection("artists");
        const eventsCollection = database.collection("events");

        console.log("Conectado a la base de datos y obteniendo lista de artistas completa...");
        
        // --- NUEVO: Extraemos artistas de dos colecciones y combinamos ---
        const artistsFromArtists = await artistsCollection.find({}).project({ name: 1, _id: 0 }).toArray();
        const artistsFromEvents = await eventsCollection.find({}).project({ artist: 1, _id: 0 }).toArray();

        const allArtists = new Set();
        artistsFromArtists.forEach(a => allArtists.add(a.name));
        artistsFromEvents.forEach(e => allArtists.add(e.artist));

        const uniqueArtists = Array.from(allArtists);
        console.log(`Se han encontrado ${uniqueArtists.length} artistas únicos.`);

        console.log("\n--- Generando y realizando búsquedas ---");

        let scrapedEvents = [];
        for (const artist of uniqueArtists) {
            const queries = generateQueries(artist);
            console.log(`Buscando para '${artist}' con las consultas:`, queries);
            
            for (const query of queries) {
                const searchResults = await searchGoogle(query);
                const relevantLinks = processSearchResults(searchResults);
                
                if (relevantLinks.length > 0) {
                    console.log(`Enlaces relevantes encontrados para '${query}':`, relevantLinks);
                    
                    for (const link of relevantLinks) {
                        try {
                            const eventData = await scrapeEventPage(link, artist);
                            if (eventData) {
                                if (Array.isArray(eventData)) {
                                    scrapedEvents.push(...eventData);
                                } else {
                                    scrapedEvents.push(eventData);
                                }
                                console.log(`Datos extraídos de ${link}:`, eventData);
                            }
                        } catch (e) {
                            console.error(`Error al procesar el enlace ${link}:`, e.message);
                        }
                    }
                } else {
                    console.log(`No se encontraron enlaces relevantes para '${query}'.`);
                }
            }
        }
        
        console.log("\n--- Proceso finalizado ---");
        await saveEventsToJson(scrapedEvents, 'nuevos_eventos.json');
        console.log("Archivo 'nuevos_eventos.json' creado con éxito.");
        
    } catch (error) {
        console.error("Error al ejecutar el Ojeador:", error);
    } finally {
        await client.close();
    }
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
    const keywords = ['conciertos', 'evento', 'gira', 'tickets', 'entradas'];
    const exclusionList = ['wikipedia.org', 'facebook.com', 'twitter.com', 'pinterest.com'];

    if (!results || results.length === 0) {
        return relevantLinks;
    }

    for (const item of results) {
        const link = item.link;
        const title = item.title.toLowerCase();
        
        const isExcluded = exclusionList.some(excludedDomain => link.includes(excludedDomain));
        if (isExcluded) {
            continue;
        }

        const isRelevant = keywords.some(keyword => title.includes(keyword) || link.includes(keyword));
        if (isRelevant) {
            relevantLinks.push(link);
        }
    }
    return relevantLinks;
}

// --- FUNCIÓN QUE VISITA EL ENLACE Y EXTRAE LOS DATOS ---
async function scrapeEventPage(url, originalArtistName) {
    if (url.includes('expoflamenco.com/agenda/eventos')) {
        try {
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);
            
            const eventTitle = $('.mec-single-title').text().trim();
            const eventArtist = $('.entry-subtitle').text().trim();
            const eventDate = $('.mec-event-d:eq(0)').text().trim();
            const eventTime = $('.mec-event-d:eq(1)').text().trim();
            const eventVenue = $('.mec-event-d:eq(2)').text().trim();
            const eventCity = $('.mec-event-d:eq(3)').text().trim();

            if (eventTitle && eventArtist) {
                const textContent = `${eventTitle} ${eventArtist} ${eventDate} ${eventVenue}`.toLowerCase();
                const isFlamenco = textContent.includes('flamenco') || textContent.includes('cante') || textContent.includes('baile');
                
                if (isFlamenco) {
                    return {
                        title: eventTitle,
                        artist: eventArtist,
                        date: eventDate,
                        time: eventTime,
                        venue: eventVenue,
                        city: eventCity,
                        provincia: getProvinciaByCity(eventCity),
                        country: 'España',
                        source: url,
                        verified: true
                    };
                }
            }
        } catch (error) {
            console.error(`Error al hacer scraping de la página ${url}:`, error.message);
        }
    } else if (url.includes('entradas.ibercaja.es/')) {
        try {
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);

            const eventTitle = $('.ibercajaSeccionTitulo').text().trim();
            const eventDate = $('#ibercajaSeccionEvento p:nth-child(2)').text().trim();
            const eventVenue = $('#ibercajaSeccionEvento p:nth-child(3)').text().trim();
            const eventPrice = $('.ibercajaPrecio').text().trim();
            const eventCity = eventVenue.split(',')[0].trim();

            if (eventTitle) {
                const textContent = `${eventTitle} ${eventDate} ${eventVenue}`.toLowerCase();
                const isFlamenco = textContent.includes('flamenco') || textContent.includes('cante') || textContent.includes('baile');
                
                if (isFlamenco) {
                    return {
                        title: eventTitle,
                        artist: originalArtistName, 
                        date: eventDate,
                        venue: eventVenue,
                        price: eventPrice,
                        city: eventCity,
                        provincia: getProvinciaByCity(eventCity),
                        country: 'España',
                        source: url,
                        verified: false 
                    };
                }
            }
        } catch (error) {
            console.error(`Error al hacer scraping de la página ${url}:`, error.message);
        }
    } else if (url.includes('holayadioslagira.es/')) {
        try {
            const { data } = await axios.get(url);
            const $ = cheerio.load(data);
            
            const events = [];
            $('.gigpress-row').each((i, el) => {
                const date = $(el).find('.gigpress-date').text().trim();
                const city = $(el).find('td:nth-child(2)').text().trim();
                const venue = $(el).find('.gigpress-venue').text().trim();
                const linkElement = $(el).find('.gigpress-links a');
                const link = linkElement.length ? linkElement.attr('href') : undefined;
                
                if (date && venue) {
                    const textContent = `${originalArtistName} ${city} ${venue}`.toLowerCase();
                    const isFlamenco = textContent.includes('flamenco') || textContent.includes('cante') || textContent.includes('baile');
                    if(isFlamenco) {
                        const event = {
                            title: 'Gira Europa 2025',
                            artist: originalArtistName, 
                            date: date,
                            city: city,
                            venue: venue,
                            provincia: getProvinciaByCity(city),
                            country: 'España',
                            source: url,
                            verified: false
                        };
                        if (link) {
                            event.link = link;
                        }
                        events.push(event);
                    }
                }
            });
            
            return events;

        } catch (error) {
            console.error(`Error al hacer scraping de la página ${url}:`, error.message);
        }
    } else if (isImageUrl(url)) {
        console.log(`Simulando la extracción de texto de la imagen: ${url}`);
        const dummyText = "Concierto de La Llama Púrpura en Sevilla el 20 de agosto. Venta de entradas en Ticketmaster.";
        return { source: 'image', text: dummyText };
    }
    console.log(`Saltando enlace no procesado: ${url}`);
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
        console.log("No se encontraron eventos para guardar.");
        return;
    }
    
    try {
        const jsonData = JSON.stringify(events, null, 2);
        fs.writeFileSync(filename, jsonData, 'utf8');
        console.log(`Se han guardado ${events.length} eventos en '${filename}'.`);
    } catch (error) {
        console.error(`Error al escribir el archivo JSON '${filename}':`, error);
    }
}

main();