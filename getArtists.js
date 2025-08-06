require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const cheerio = require('cheerio'); 
const fs = require('fs');
const path = require('path');

// --- CONFIGURACIÓN ---
const mongoUri = process.env.MONGO_URI;
const googleApiKey = process.env.GOOGLE_API_KEY;
const googleCx = process.env.GOOGLE_CX;
// const QUERY_LIMIT = 90; // Límite desactivado correctamente

if (!mongoUri || !googleApiKey || !googleCx) {
    throw new Error('Faltan variables de entorno críticas.');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScraper() {
    console.log("Iniciando ojeador con lógica de filtrado y scraping Cheerio...");
    const client = new MongoClient(mongoUri);
    let allNewEvents = []; 
    let queryCount = 0;

    try {
        await client.connect();
        const database = client.db('DuendeDB');
        const artistsCollection = database.collection('artists');
        console.log("✅ Conectado a la base de datos.");

        // Para probar, puedes limitar a 5 artistas. Para la ejecución completa, quita el .limit(5)
        const artistsToSearch = await artistsCollection.find({}).limit(5).toArray(); 
        console.log(`Encontrados ${artistsToSearch.length} artistas en la base de datos para buscar.`);

        for (const artist of artistsToSearch) {
            console.log(`-------------------------------------------`);
            console.log(`(Consulta #${queryCount + 1}) Buscando eventos para: ${artist.name}`);
            
            try {
                // =============================================================
                // --- INICIO DE LA NUEVA LÓGICA INTELIGENTE CON SCRAPING ---
                // =============================================================

                // 1. MEJORAMOS LA BÚSQUEDA
                const searchQuery = `concierto flamenco "${artist.name}" 2025`;
                const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(searchQuery)}`;
                
                queryCount++; 
                const response = await axios.get(searchUrl);
                const searchResults = response.data.items || [];
                console.log(` -> Encontrados ${searchResults.length} resultados en Google.`);
                
                const parsedEvents = []; 
                
                // 2. CREAMOS EL FILTRO INTELIGENTE
                const positiveKeywords = ['concierto', 'festival', 'actuación', 'gira', 'entradas', 'tickets', 'fecha'];
                const negativeKeywords = ['noticia', 'entrevista', 'disco', 'álbum', 'vídeo'];
                
                for (const result of searchResults) {
                    const title = result.title.toLowerCase();
                    const snippet = result.snippet.toLowerCase();
                    const artistNameLower = artist.name.toLowerCase();

                    const textToSearch = title + " " + snippet;

                    if (!textToSearch.includes(artistNameLower)) {
                        continue; 
                    }

                    const hasPositive = positiveKeywords.some(keyword => textToSearch.includes(keyword));
                    const hasNegative = negativeKeywords.some(keyword => textToSearch.includes(keyword));

                    if (hasPositive && !hasNegative) {
                        console.log(`   -> Candidato encontrado: "${result.title}"`);
                        console.log(`   -> Scrapeando detalles de: ${result.link}`);

                        let eventData = {
                            id: `evt-${artist._id}-${queryCount}-${parsedEvents.length}`, 
                            name: result.title, 
                            description: result.snippet, 
                            date: null,
                            time: null,
                            venue: null,
                            city: null,
                            verified: false,
                            sourceUrl: result.link,
                            artist: artist.name,
                        };

                        try {
                            const pageResponse = await axios.get(result.link, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                                },
                                timeout: 10000 // Aumentamos el timeout a 10 segundos
                            });
                            const $ = cheerio.load(pageResponse.data);

                            // --- LÓGICA DE SCRAPING CON CHEERIO ---
                            const sourceUrl = result.link;

                            // Lógica para la web de la Junta de Andalucía
                            if (sourceUrl.includes('juntadeandalucia.es')) {
                                const locationElement = $('a.text_accent_text_base');
                                const locationText = locationElement.text().trim();
                                if (locationText) {
                                    const parts = locationText.split(',');
                                    eventData.city = parts[parts.length - 2] ? parts[parts.length - 2].trim() : null;
                                    eventData.venue = locationText; 
                                }

                                const dateElement = $('div.text_base').eq(1); 
                                const dateText = dateElement.text().trim();
                                if (dateText) {
                                    eventData.date = dateText;
                                }

                                const timeElement = $('div.text_base').eq(2); 
                                const timeText = timeElement.text().trim();
                                if (timeText) {
                                    eventData.time = timeText.replace('horas.', '').trim();
                                }
                            }
                            // Lógica para la web de El Corte Inglés
                            else if (sourceUrl.includes('elcorteingles.es')) {
                                const nameText = $('h1.product-header__main-title').text().trim();
                                if (nameText) {
                                    eventData.name = nameText;
                                }
                            
                                const items = $('p.product-header__bottom_item-text');
                                items.each((i, elem) => {
                                    const text = $(elem).text().trim();
                                    if (text.startsWith('Fechas:')) {
                                        eventData.date = text.replace('Fechas:', '').trim();
                                    } else if (text.startsWith('Horario:')) {
                                        eventData.time = text.replace('Horario:', '').trim();
                                    }
                                });
                            
                                const venueText = $('p.product-header__link a').text().trim();
                                if (venueText) {
                                    eventData.venue = venueText;
                                }
                            
                                const title = $('title').text();
                                const cityMatch = title.match(/ en ([^|]+)/i);
                                if (cityMatch && cityMatch.length > 1) {
                                    eventData.city = cityMatch[1].trim();
                                }
                            }
                            // --- FIN DE LA LÓGICA ESPECÍFICA ---
                            
                            if (eventData.date || eventData.venue) {
                                parsedEvents.push(eventData);
                            } else {
                                parsedEvents.push(eventData);
                            }

                        } catch (scrapeError) {
                            console.error(`     -> ⚠️ Error al scrapear ${result.link}:`, scrapeError.message);
                            parsedEvents.push(eventData);
                        }
                        
                    }
                }
                
                // =============================================================
                // --- FIN DE LA NUEVA LÓGICA INTELIGENTE CON SCRAPING ---
                // =============================================================

                if (parsedEvents.length > 0) {
                    console.log(` -> ¡Éxito! Se han parseado ${parsedEvents.length} eventos nuevos para este artista.`);
                    allNewEvents.push(...parsedEvents);
                }

            } catch (error) {
                 if (error.response && error.response.status === 429) {
                    console.error(`   -> ❌ ERROR 429: Cuota de Google excedida...`);
                    await delay(60000);
                 } else {
                    console.error(`   -> ❌ Error buscando para ${artist.name}:`, error.message);
                 }
            }
            await delay(1500); // Pausa entre artistas
        }

        console.log(`-------------------------------------------`);
        console.log(`Proceso de búsqueda finalizado. Total de eventos nuevos encontrados: ${allNewEvents.length}`);
        
        if (allNewEvents.length > 0) {
            console.log("Guardando eventos encontrados en la colección temporal de la base de datos...");
            const tempCollection = database.collection('temp_scraped_events');
            await tempCollection.deleteMany({}); 
            await tempCollection.insertMany(allNewEvents);
            console.log(`✅ ${allNewEvents.length} eventos guardados con éxito en la colección 'temp_scraped_events'.`);
        } else {
            console.log("No se encontraron eventos nuevos en esta ejecución.");
        }

    } catch (error) {
        console.error("Ha ocurrido un error fatal en el proceso principal:", error);
    } finally {
        await client.close();
        console.log("Conexión con la base de datos cerrada.");
    }
}

runScraper();