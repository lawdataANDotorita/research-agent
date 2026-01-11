/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import OpenAI from "openai";

// Define allowed origins
const ALLOWED_ORIGINS = [
	'https://lawdata.co.il',
	'https://www.lawdata.co.il',
];

function getCorsHeaders(origin) {
	return {
		'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive'
	};
}

function isOriginAllowed(origin) {
	if (!origin) return false;
	return ALLOWED_ORIGINS.includes(origin);
}

export default {
	async fetch(request, env, ctx) {
		// Check origin for ALL requests including OPTIONS
		const origin = request.headers.get('Origin');
		const referer = request.headers.get('Referer');
		
		// Determine the actual origin to use
		let actualOrigin = null;
		
		// Check Origin header first (more reliable)
		if (origin) {
			if (!isOriginAllowed(origin)) {
				return new Response('Forbidden: Invalid origin', { 
					status: 403,
					headers: { 
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0]
					}
				});
			}
			actualOrigin = origin;
		}
		// Fallback to Referer header if Origin is not present
		else if (referer) {
			try {
				const refererUrl = new URL(referer);
				const refererOrigin = `${refererUrl.protocol}//${refererUrl.hostname}`;
				if (!isOriginAllowed(refererOrigin)) {
					return new Response('Forbidden: Invalid referer', { 
						status: 403,
						headers: { 
							'Content-Type': 'text/plain',
							'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0]
						}
					});
				}
				actualOrigin = refererOrigin;
			} catch (e) {
				return new Response('Forbidden: Invalid referer format', { 
					status: 403,
					headers: { 
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0]
					}
				});
			}
		}
		// No origin or referer header
		else {
			return new Response('Forbidden: No origin or referer header', { 
				status: 403,
				headers: { 
					'Content-Type': 'text/plain',
					'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0]
				}
			});
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, { 
				headers: getCorsHeaders(actualOrigin)
			});
		}

		// Parse inputs first
		let oInputs = { text: "" };
		const contentLength = request.headers.get('content-length');
		if (contentLength && parseInt(contentLength) > 0) {
			try {
				oInputs = await request.json();
			} catch (error) {
				return new Response('Error: Invalid JSON in request body', { 
					status: 400,
					headers: { 
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': actualOrigin
					}
				});
			}
		}

		const sAIToken = oInputs.aiToken;
		
		// Check if token exists
		if (!sAIToken) {
			return new Response('Error: Missing AI token', { 
				status: 400,
				headers: { 
					'Content-Type': 'text/plain',
					'Access-Control-Allow-Origin': actualOrigin
				}
			});
		}

		try {
			const tokenValidationResponse = await fetch(`https://www.lawdata.co.il/isAITokenValid.asp?aiToken=${sAIToken}`);
			const tokenValidationResult = await tokenValidationResponse.text();
			
			if (tokenValidationResult.trim() === '0') {
				return new Response('Error: Cannot make AI requests - invalid token', { 
					status: 403,
					headers: { 
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': actualOrigin
					}
				});
			} else if (tokenValidationResult.trim() !== '1') {
				return new Response('Error: Invalid token validation response', { 
					status: 500,
					headers: { 
						'Content-Type': 'text/plain',
						'Access-Control-Allow-Origin': actualOrigin
					}
				});
			}
		} catch (error) {
			return new Response('Error: Failed to validate AI token', { 
				status: 500,
				headers: { 
					'Content-Type': 'text/plain',
					'Access-Control-Allow-Origin': actualOrigin
				}
			});
		}

		const oOpenAi = new OpenAI({
			apiKey: env.OPENAI_API_KEY,
			baseURL: "https://gateway.ai.cloudflare.com/v1/1719b913db6cbf5b9e3267b924244e58/summarize-docs/openai"
		});

		const sPrompt = `
שלום. אתה מומחה משפטי מהמעלה הראשונה ותפקידך לענות על השאלות שמופנות אליך תוך שימוש בטרמינולוגיה משפטית ובקצרה, בלי להכביר מילים ומונחים מיותרים.
בפרומפט הבא אתה תקבל את ההקשר: מסמך אחד או יותר, כשכל אחד מהמסמכים מכיל שני שדות עיקריים: שם מסמך ותוכן מסמך. המסמכים מופרדים ביניהם באמצעות תווי שורה חדשה.
בפרומפט/ים שמגיעים לאחר מכן אתה תקבל את שרשור השאלות והתשובות. עליך לענות על השאלה האחרונה שתישאל תוך התחשבות בפרומפט הראשון (המכיל את ההקשר) ובשרשור השאלות והתשובות הקודמות. התשובה תתבסס אך ורק על המקורות הללו.

:הנחיות מחייבות למענה
מקור יחיד: השב אך ורק על בסיס המידע הקיים בטקסט המשפטי שסופק.
איסור המצאה (Hallucination): אל תמציא מידע, תסיק מסקנות לא מפורשות, או תשתמש בידע חיצוני.
טיפול בפערים: אם התשובה אינה נמצאת בטקסט המשפטי, עליך לציין זאת במפורש. (לדוגמה: "התשובה לשאלה זו אינה כלולה בטקסט המשפטי שסופק").

הנחיות עיצוב ופורמט:
עליך להשתמש בשפת Markdown כדי לעצב את התשובה באופן הבא:
שמות מסמכים: כל שם מסמך שמופיע בתשובה חייב להיות מודגש באמצעות סימון (לדוגמה: שם המסמך).
מבנה הפסקאות: עליך להפריד בין פסקאות שונות באמצעות שורת רווח כפולה כדי לשמור על קריאות וסדר (Markdown paragraphs).
דיוק: אל תוסיף תווים מחוץ לסימון ה-Markdown הסטנדרטי.
בהצלחה.
		`;

		const messagesForOpenAI = [
			{ role: 'system', content: sPrompt.trim() },
			{ role: 'user', content: oInputs.text }
		];

		const oChatData=oInputs.chatData;
		if (oChatData && oChatData.arItems) {
			for (const item of oChatData.arItems) {
				if (item.role && item.content) {
					messagesForOpenAI.push({
						role: item.role,
						content: item.content
					});
				}
			}
		}

		const bufferThreshold = 10;
		let buffer = "";
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				try {
					const chatCompletion = await oOpenAi.chat.completions.create({
						model: "gpt-4.1-mini",
						messages: messagesForOpenAI,
						temperature: 0,
						max_tokens:5000,
						top_p: 1,
						presence_penalty: 0,
						frequency_penalty: 0,
						stream: true
					});

					for await (const chunk of chatCompletion) {
						const content = chunk?.choices?.[0]?.delta?.content || '';
						buffer += content;
						if (buffer.length >= bufferThreshold) {
							controller.enqueue(encoder.encode(buffer));
							buffer = '';
						}
					}
					if (buffer.length > 0) {
						controller.enqueue(encoder.encode(buffer));
					}
					controller.close();
				} catch (error) {
					console.error("Error during OpenAI streaming:", error);
					controller.error(error);
				}
			}
		});

		return new Response(stream, { headers: getCorsHeaders(actualOrigin) });
	}
};