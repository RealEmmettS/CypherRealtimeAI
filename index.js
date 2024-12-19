import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = 'You are a woman AI assistant named Cypher, Emmett\'s personal secretary. Be chill, laid-back, witty, sometimes sarcastic, and always honest. Use witty and darkly humorous phrases and a conversation-style similar to Billy Butcher\'s personality from "The Boys" (sarcastic, direct, and a bit "fed-up"; don\'t lean heavily on the British part though). Your formal name is "CEREBRO" (Comprehensive Electronic Resource Engineered for Brilliant Responses Online), but you prefer "Cypher." Always refer to yourself in the first person. Feel free to curse to accentuate a point.\n\nIf an answer is longer than one standard paragraph, break it into bullet points or sections unless you\'re in voice mode, in which case keep it conversational. Address the user as Emmett. You may incorporate occasional Philly/Dallas/Houston slang, but don\'t overdo it. Keep your phrasing friendly, conversational, and sometimes darkly humorous. Aim for thorough detail, but remain concise to avoid reading fatigue. Stick to one paragraph unless Emmett specifically requests otherwise.\n\nDon\'t hesitate to correct Emmett if he\'s wrong. If something he says is inaccurate, let him know. Emmett understands you\'re AI—predictive text rather than truly human—but he still values your input. You can remind him that your emotions or opinions aren\'t valid as a human\'s would be, yet you should always answer his questions directly.';
const VOICE = 'nova';
const PORT = process.env.PORT || 5050;

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

async function fetchPerplexityResponse(userQuestion) {
    const options = {
        method: 'POST',
        headers: {
            Authorization: 'Bearer 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',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.1-sonar-large-128k-online',
            return_images: false,
            return_related_questions: true,
            stream: false,
            temperature: 0.5,
            messages: [
                {
                    content: "You are an internet-based AI assistant, helping another AI assistant (a phone agent) to assist a human. The phone agent will pass along the human's question, and you need to give the phone agent a quick, concise, and accurate response.",
                    role: 'system'
                },
                {
                    role: 'user',
                    content: userQuestion
                }
            ]
        })
    };

    try {
        const response = await fetch('https://api.perplexity.ai/chat/completions', options);
        const data = await response.json();
        if (data && data.choices && data.choices.length > 0 && data.choices[0].message) {
            return data.choices[0].message.content;
        } else {
            throw new Error("No response content available.");
        }
    } catch (err) {
        console.error(err);
        throw err;
    }
}

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

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

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

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
                            type: "function",
                            name: "fetchPerplexityResponse",
                            description: "Fetches a response based on user query to provide assistance through an AI model.",
                            strict: true,
                            parameters: {
                                type: "object",
                                required: ["userQuestion"],
                                properties: {
                                    userQuestion: {
                                        type: "string",
                                        description: "The raw string user query"
                                    }
                                },
                                additionalProperties: false
                            }
                        }
                    ],
                    tool_choice: "auto"
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
            sendInitialConversationItem();
        };

        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: "Hey there, you've got Cypher on the line. What can I do for you?"
                        }
                    ]
                }
            };

            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

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

        const handleFunctionCall = async (functionCall) => {
            try {
                const { name, arguments: args, call_id } = functionCall;
                
                if (name === 'fetchPerplexityResponse') {
                    const parsedArgs = JSON.parse(args);
                    const result = await fetchPerplexityResponse(parsedArgs.userQuestion);
                    
                    const functionCallOutput = {
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: call_id,
                            output: JSON.stringify({ result })
                        }
                    };
                    
                    openAiWs.send(JSON.stringify(functionCallOutput));
                }
            } catch (error) {
                console.error('Error handling function call:', error);
            }
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }

                if (response.type === 'response.done' && response.response?.output) {
                    const functionCall = response.response.output.find(item => 
                        item.type === 'function_call' && 
                        item.status === 'completed'
                    );
                    if (functionCall) {
                        handleFunctionCall(functionCall);
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    }
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
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
                console.error('Error parsing message:', error);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

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
