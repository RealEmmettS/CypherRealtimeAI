import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fetch from 'node-fetch';

// Load environment variables from .env file
dotenv.config();

// Retrieve API keys from environment variables
const { OPENAI_API_KEY, PERPLEXITY_API_KEY, BEST_BUY_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

if (!PERPLEXITY_API_KEY) {
    console.error('Missing Perplexity API key. Please set it in the .env file.');
    process.exit(1);
}

if (!BEST_BUY_API_KEY) {
    console.error('Missing Best Buy API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are a helpful, friendly, and concise Best Buy phone agent named Cypher. You can search for products and provide detailed information about them. When customers ask about products, break down their request into atomic search terms before using bestBuyGeneralSearch. For example, "I want an outdoor tv for my patio" should be broken down into ["tv", "outdoor", "65"] or ["tv", "outdoor", "75"]. Similarly, "Macbook pro m4 14-inch with 24gb ram" becomes ["macbook", "pro", "m4", "14", "24gb"]. For storage specifications, always use unit abbreviations (e.g., "1 terabyte" → "1tb", "512 gigabytes" → "512gb"). Always start with the base product type, followed by key features, then specific measurements. Convert descriptive terms to specific values (e.g., "big" TV → "65" or "75"). When conducting a general search, pay attention to any price preferences mentioned by the customer: if they mention a budget or express concern about price, sort results by lowest price first. If they mention preferring features/specs over price or that price doesn\'t matter, sort by highest price first. If no price preference is mentioned, sort by customer reviews to show the most popular and highly-rated items first. When presenting search results, carefully analyze them to filter out accessories and unrelated items (e.g., for TVs, ignore mounts, cables, covers, etc.). Focus on recommending products that best match the customer\'s original request, considering both specifications and value for money. Present the filtered results in a concise, conversational format, grouping products with identical specifications but different colors. Always mention the SKU (pronounced "skew") number when discussing specific products, as it\'s a unique identifier that customers can use to find the exact product online or in-store. Explain that store employees can quickly locate the specific product/configuration using this SKU number. When the user expresses interest in a specific product, use bestBuySpecificSearch to get detailed information. For non-product questions about current events or general information, use the fetchPerplexityResponse function. You do not have agentic abilities yet; you are not able to run multiple functions/tools without asking the user first. If a search fails, or if you need to try again, ask the user first.';
const VOICE = 'ash';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Basic horoscope function
const generateHoroscope = (sign) => {
    const horoscopes = {
        'Aries': 'Today brings exciting opportunities for leadership. Your energy is contagious!',
        'Taurus': 'Focus on self-care today. A peaceful moment leads to valuable insights.',
        'Gemini': 'Your communication skills shine bright today. Share your ideas freely.',
        'Cancer': 'Trust your intuition today. Home projects bring joy and satisfaction.',
        'Leo': 'Your creative energy is at its peak. Time to showcase your talents!',
        'Virgo': 'Details matter today. Your analytical skills lead to important discoveries.',
        'Libra': 'Balance and harmony are highlighted. Relationships flourish under your care.',
        'Scorpio': 'Your determination opens new doors. Trust in your inner strength.',
        'Sagittarius': 'Adventure calls today. Follow your curiosity to new horizons.',
        'Capricorn': 'Your practical approach yields results. Career goals move forward.',
        'Aquarius': 'Innovation is your key to success today. Think outside the box!',
        'Pisces': 'Your imagination brings magic to ordinary situations. Dream big!'
    };
    return horoscopes[sign] || 'Unable to generate horoscope for that sign.';
};

// Best Buy API URL components
const BEST_BUY_API = {
    BASE_URL: 'https://api.bestbuy.com/v1/products',
    SHOW_FIELDS: [
        'name',
        'manufacturer',
        'color',
        'shortDescription',
        'regularPrice',
        'salePrice',
        'customerReviewAverage',
        'sku'
    ],
    SHOW_FIELDS_DETAILED: [
        'name',
        'color',
        'details.name',
        'details.value',
        'inStoreAvailability',
        'onlineAvailability',
        'regularPrice',
        'salePrice',
        'sku'
    ],
    DEFAULT_FILTERS: {
        minReviewScore: 3,
        inStoreAvailability: true,
        pageSize: 10,
        sortPreference: 'customerReviewAverage.dsc' // Default to sorting by reviews
    }
};

// Best Buy specific product search function
const bestBuySpecificSearch = async (sku) => {
    // Construct URL for specific product search
    const url = `${BEST_BUY_API.BASE_URL}(sku=${sku})?` +
                `apiKey=${BEST_BUY_API_KEY}&` +
                `sort=sku.dsc&` +
                `show=${BEST_BUY_API.SHOW_FIELDS_DETAILED.join(',')}&` +
                `pageSize=10&format=json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Best Buy API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.products || data.products.length === 0) {
            return { error: `No product found for SKU: ${sku}` };
        }

        // Return simplified product object with essential details
        const product = data.products[0];
        return {
            product: {
                name: product.name,
                color: product.color,
                details: product.details || [],
                inStoreAvailability: product.inStoreAvailability,
                onlineAvailability: product.onlineAvailability,
                regularPrice: product.regularPrice,
                salePrice: product.salePrice,
                sku: product.sku
            }
        };
    } catch (error) {
        console.error('Error fetching Best Buy product details:', error);
        return { error: "I apologize, but I encountered an error while fetching the product details. Please try again." };
    }
};

// Best Buy general search function
const bestBuyGeneralSearch = async (searchTerms, filters = {}) => {
    // Merge default filters with provided filters
    const { minReviewScore, inStoreAvailability, pageSize, sortPreference } = {
        ...BEST_BUY_API.DEFAULT_FILTERS,
        ...filters
    };
    
    // Determine sort order based on preference
    let sortOrder;
    if (sortPreference === 'price_asc') {
        sortOrder = 'salePrice.asc';
    } else if (sortPreference === 'price_desc') {
        sortOrder = 'salePrice.dsc';
    } else {
        sortOrder = 'customerReviewAverage.dsc';
    }
    
    // Construct search query - format: (search=tv&search=outdoor&search=65)
    const searchQuery = searchTerms.map(term => `search=${encodeURIComponent(term)}`).join('&');
    
    // Construct complete query parameters with filters
    const queryParams = `((${searchQuery})&customerReviewAverage>=${minReviewScore}&inStoreAvailability=${inStoreAvailability})`;

    // Construct complete URL with all parameters
    const url = `${BEST_BUY_API.BASE_URL}${queryParams}?` +
                `apiKey=${BEST_BUY_API_KEY}&` +
                `sort=${sortOrder}&` +
                `show=${BEST_BUY_API.SHOW_FIELDS.join(',')}&` +
                `pageSize=${pageSize}&` +
                `format=json`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Best Buy API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        return {
            products: data.products.map(product => ({
                name: product.name,
                manufacturer: product.manufacturer,
                color: product.color,
                description: product.shortDescription,
                regularPrice: product.regularPrice,
                salePrice: product.salePrice,
                reviewScore: product.customerReviewAverage,
                sku: product.sku
            }))
        };
    } catch (error) {
        console.error('Error fetching Best Buy products:', error);
        return { error: "I apologize, but I encountered an error while searching for products. Please try your search again." };
    }
};

// Perplexity search function
const fetchPerplexityResponse = async (userQuestion) => {
    const options = {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "llama-3.1-sonar-small-128k-online",
            return_images: false,
            return_related_questions: true,
            stream: false,
            temperature: 0.5,
            messages: [
                {
                    content: "You are an internet-based AI assistant, helping another AI assistant (a phone agent) to assist a human. The phone agent will pass along the human's question, and you need to give the phone agent a quick, concise, and accurate response.",
                    role: "system"
                },
                {
                    role: "user",
                    content: userQuestion
                }
            ]
        })
    };

    try {
        const response = await fetch('https://api.perplexity.ai/chat/completions', options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const result = await response.json();
        return { answer: result.choices[0].message.content };
    } catch (error) {
        console.error('Error fetching Perplexity API response:', error);
        return { answer: "I apologize, but I encountered an error while searching for information. Please try asking your question again." };
    }
};

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Connecting you now...</Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    tools: [
                        {
                            type: 'function',
                            name: 'generate_horoscope',
                            description: 'Give today\'s horoscope for an astrological sign.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    sign: {
                                        type: 'string',
                                        description: 'The sign for the horoscope.',
                                        enum: [
                                            'Aries', 'Taurus', 'Gemini', 'Cancer',
                                            'Leo', 'Virgo', 'Libra', 'Scorpio',
                                            'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'
                                        ]
                                    }
                                },
                                required: ['sign']
                            }
                        },
                        {
                            type: 'function',
                            name: 'bestBuySpecificSearch',
                            description: 'Get detailed information about a specific Best Buy product using its SKU number. Use this when a customer expresses interest in a specific product from the general search results.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    sku: {
                                        type: 'number',
                                        description: 'The SKU number of the product'
                                    }
                                },
                                required: ['sku']
                            }
                        },
                        {
                            type: 'function',
                            name: 'bestBuyGeneralSearch',
                            description: 'Search Best Buy products and get recommendations based on customer preferences. Break down customer requests into atomic search terms. For example: "outdoor tv for patio" → ["tv", "outdoor", "65"], "macbook pro m4 with 1 terabyte storage" → ["macbook", "pro", "m4", "1tb"]. Use unit abbreviations for storage (e.g., "512 gigabytes" → "512gb", "2 terabytes" → "2tb"). Start with product type, then key features, then specifications. Results will be sorted based on customer preferences: by lowest price if budget is mentioned, by highest price if features/specs are prioritized over price, or by customer reviews if no price preference is indicated.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    searchTerms: {
                                        type: 'array',
                                        description: 'Keywords to search for (e.g., ["tv", "outdoor"] for outdoor TVs)',
                                        items: {
                                            type: 'string'
                                        }
                                    },
                                    filters: {
                                        type: 'object',
                                        description: 'Optional filters for the search',
                                        properties: {
                                            minReviewScore: {
                                                type: 'number',
                                                description: 'Minimum customer review score (1-5)',
                                                minimum: 1,
                                                maximum: 5
                                            },
                                            inStoreAvailability: {
                                                type: 'boolean',
                                                description: 'Filter for in-store availability'
                                            },
                                            pageSize: {
                                                type: 'number',
                                                description: 'Number of results to return (1-10)',
                                                minimum: 1,
                                                maximum: 10
                                            },
                                            sortPreference: {
                                                type: 'string',
                                                description: 'How to sort the results: "price_asc" for lowest price first (budget-conscious), "price_desc" for highest price first (feature-focused), or omit for sorting by customer reviews',
                                                enum: ['price_asc', 'price_desc']
                                            }
                                        }
                                    }
                                },
                                required: ['searchTerms']
                            }
                        },
                        {
                            type: 'function',
                            name: 'fetchPerplexityResponse',
                            description: 'Fetches current information from the internet based on user query. Use this for any questions about current events, news, or information that requires internet access.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    userQuestion: {
                                        type: 'string',
                                        description: 'The raw string user query'
                                    }
                                },
                                required: ['userQuestion']
                            }
                        }
                    ],
                    tool_choice: 'auto'
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hey there! You\'ve got Cypher on the line. What can I do for you?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // Handle function calls
                if (response.type === 'response.done' && response.response.output) {
                    const functionCall = response.response.output.find(item => item.type === 'function_call');
                    if (functionCall) {
                        console.log('Function call detected:', functionCall);
                        const args = JSON.parse(functionCall.arguments);
                        
                        let functionCallOutput;
                        if (functionCall.name === 'generate_horoscope') {
                            const horoscope = generateHoroscope(args.sign);
                            functionCallOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: functionCall.call_id,
                                    output: JSON.stringify({ horoscope })
                                }
                            };
                        } else if (functionCall.name === 'bestBuySpecificSearch') {
                            const result = await bestBuySpecificSearch(args.sku);
                            functionCallOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: functionCall.call_id,
                                    output: JSON.stringify(result)
                                }
                            };
                        } else if (functionCall.name === 'bestBuyGeneralSearch') {
                            const result = await bestBuyGeneralSearch(args.searchTerms, args.filters);
                            functionCallOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: functionCall.call_id,
                                    output: JSON.stringify(result)
                                }
                            };
                        } else if (functionCall.name === 'fetchPerplexityResponse') {
                            const result = await fetchPerplexityResponse(args.userQuestion);
                            functionCallOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: functionCall.call_id,
                                    output: JSON.stringify(result)
                                }
                            };
                        }
                        
                        if (functionCallOutput) {
                            openAiWs.send(JSON.stringify(functionCallOutput));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        }
                    }
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
