import { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

// Initialize Clients
const sqsClient = new SQSClient({});
const pollyClient = new PollyClient({});
const s3Client = new S3Client({});
const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

const QUEUE_URL = process.env.QUEUE_URL;
const BUCKET_NAME = process.env.BUCKET_NAME;
const TABLE_NAME = process.env.TABLE_NAME;

/**
 * Ingests text from client, saves to DynamoDB as PENDING, queries SQS.
 */
export const synthesizeHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        console.log('Received event:', JSON.stringify(event));

        const body = event.body ? JSON.parse(event.body) : {};
        const text = body.text;

        if (!text) {
            return {
                statusCode: 400,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Missing 'text' in request body" }),
            };
        }

        const jobId = randomUUID();

        if (!QUEUE_URL || !TABLE_NAME) {
            throw new Error('QUEUE_URL or TABLE_NAME environment variables are not set');
        }

        // 1. Write to DynamoDB (PENDING)
        await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                jobId,
                status: 'PENDING',
                text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                createdAt: new Date().toISOString()
            }
        }));

        // 2. Push to SQS
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: QUEUE_URL,
            MessageBody: JSON.stringify({
                jobId,
                text,
                voiceId: body.voiceId || 'Joanna',
                outputFormat: body.outputFormat || 'mp3',
                textType: body.textType || 'text'
            })
        }));

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
                message: 'Job queued successfully',
                jobId: jobId
            }),
        };

    } catch (err) {
        console.error('Error in synthesizeHandler:', err);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: 'Internal Server Error' }),
        };
    }
};

/**
 * Consumes from SQS, updates DB to PROCESSING, calls Polly, saves to S3, updates to COMPLETED.
 */
export const processorHandler = async (event: SQSEvent): Promise<void> => {
    try {
        console.log('Processing SQSEvent:', JSON.stringify(event));

        for (const record of event.Records) {
            const payload = JSON.parse(record.body);
            const { jobId, text, voiceId, outputFormat, textType } = payload;

            if (!text || !jobId) {
                console.warn('Skipping invalid payload:', record.body);
                continue;
            }

            console.log(`Processing Job: ${jobId}`);

            if (!TABLE_NAME) throw new Error('TABLE_NAME is not set');

            // 1. Update State to PROCESSING
            await docClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { jobId },
                UpdateExpression: 'set #status = :status, updatedAt = :updatedAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'PROCESSING', ':updatedAt': new Date().toISOString() }
            }));

            // 2. Call Polly
            const pollyResponse = await pollyClient.send(new SynthesizeSpeechCommand({
                Text: text,
                OutputFormat: outputFormat || 'mp3',
                VoiceId: voiceId || 'Joanna',
                TextType: textType || 'text'
            }));

            if (!pollyResponse.AudioStream) {
                throw new Error('No AudioStream returned from Polly');
            }

            // Convert AudioStream to Buffer
            const streamToBuffer = async (stream: any): Promise<Buffer> => {
                return new Promise((resolve, reject) => {
                    const chunks: any[] = [];
                    stream.on('data', (chunk: any) => chunks.push(chunk));
                    stream.on('error', reject);
                    stream.on('end', () => resolve(Buffer.concat(chunks)));
                });
            };

            const audioBuffer = await streamToBuffer(pollyResponse.AudioStream);

            if (!BUCKET_NAME) throw new Error('BUCKET_NAME is not set');

            // 3. Save to S3
            const key = `${jobId}.${outputFormat || 'mp3'}`;
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key,
                Body: audioBuffer,
                ContentType: outputFormat === 'pcm' ? 'audio/pcm' : 'audio/mpeg'
            }));

            // 4. Update State to COMPLETED
            await docClient.send(new UpdateCommand({
                TableName: TABLE_NAME,
                Key: { jobId },
                UpdateExpression: 'set #status = :status, s3Key = :s3Key, updatedAt = :updatedAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'COMPLETED', ':s3Key': key, ':updatedAt': new Date().toISOString() }
            }));

            console.log(`Successfully completed Job: ${jobId}`);
        }

    } catch (err) {
        console.error('Error in processorHandler:', err);
        throw err;
    }
};

/**
 * Returns JSON status of a job. If COMPLETED, returns presigned S3 url.
 */
export const statusHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const jobId = event.pathParameters?.jobId;

        if (!jobId || !TABLE_NAME) {
            return {
                statusCode: 400,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Missing jobId" })
            };
        }

        const dbResponse = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { jobId }
        }));

        const item = dbResponse.Item;

        if (!item) {
            return {
                statusCode: 404,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ message: "Job not found" })
            };
        }

        let audioUrl = null;

        if (item.status === 'COMPLETED' && BUCKET_NAME && item.s3Key) {
            // Generate presigned URL
            const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: item.s3Key });
            audioUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        }

        return {
            statusCode: 200,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({
                jobId: item.jobId,
                status: item.status,
                audioUrl: audioUrl
            })
        };

    } catch (err) {
        console.error('Error in statusHandler:', err);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ message: 'Internal Server Error' })
        };
    }
};

/**
 * Serves an HTML UI dashboard
 */
export const uiHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const html = `
    <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AWS Polly Voice Hub</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --background: #0f172a;
            --card-bg: white;
            --panel-bg: rgba(15, 23, 42, 0.55);
            --text: black;
            --muted: #34445c;
            --border: rgba(255, 255, 255, 0.08);
            --pending: #eab308;
            --processing: #3b82f6;
            --completed: #22c55e;
            --chip-bg:rgb(99 102 241);
            --chip-text: #c7d2fe;
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-image:
              radial-gradient(at 0% 0%, rgb(99 102 241 / 53%) 0px, transparent 50%), 
              radial-gradient(at 98% 100%, rgb(217 70 219 / 28%) 0px, transparent 50%);
            color: var(--text);
            margin: 0;
            min-height: 100vh;
            padding: 32px;
        }

        .page {
            max-width: 1320px;
            margin: 0 auto;
            animation: fadeIn 0.8s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(16px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .layout {
            display: grid;
            grid-template-columns: 420px minmax(0, 1fr);
            gap: 24px;
            align-items: start;
        }

        .panel {
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 24px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45);
        }

        .samples-panel {
            padding: 1.25rem;
            max-height: calc(100vh - 64px);
            overflow: auto;
        }

        .main-panel {
            padding: 2rem;
        }

        h1 {
            font-weight: 700;
            font-size: 2rem;
            margin: 0 0 0.5rem 0;
            letter-spacing: -0.03em;
        }

        h2 {
            font-weight: 600;
            font-size: 1.1rem;
            margin: 0;
            letter-spacing: -0.02em;
        }

        p.subtitle {
            color: var(--muted);
            margin: 0 0 2rem 0;
            font-size: 0.98rem;
        }

        .section-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 1rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid var(--border);
        }

        .section-head .helper {
            font-size: 0.82rem;
            color: var(--muted);
        }

        .sample-list {
            display: grid;
            gap: 0.9rem;
        }

        .sample-card {
            border:1px solid rgb(99 102 241 / 45%);
            border-radius: 18px;
            padding: 0.95rem;
            cursor: pointer;
            transition: transform 0.14s ease, border-color 0.2s ease, background 0.2s ease;
        }

        .sample-card:hover {
            transform: translateY(-2px);
            border-color: rgba(99, 102, 241, 0.35);
            background: #6366f12b;
        }

        .sample-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            margin-bottom: 0.45rem;
        }

        .sample-title {
            font-size: 0.95rem;
            font-weight: 600;
            line-height: 1.3;
        }

        .chip {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            padding: 0.22rem 0.65rem;
            border-radius: 9999px;
            font-size: 0.72rem;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .chip.ssml {
            background: var(--chip-bg);
            color: var(--chip-text);
            border: 1px solid rgba(99, 102, 241, 0.25);
        }

        .chip.text {
            background: rgba(148, 163, 184, 0.12);
            color: black;
            border: 1px solid;
        }

        .sample-preview {
            font-size: 0.85rem;
            color: var(--muted);
            line-height: 1.45;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        textarea {
            width: 100%;
   
            border: 1px solid rgb(0 0 0 / 49%);
            border-radius: 16px;
            padding: 1rem;
            color: var(--text);
            font-family: inherit;
            font-size: 0.95rem;
            line-height: 1.5;
            resize: vertical;
            min-height: 230px;
            margin-bottom: 1rem;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        textarea:focus,
        select:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15);
        }

        .controls {
            display: flex;
            gap: 1rem;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
        }

        .control-group {
            flex: 1;
            min-width: 160px;
        }

        .control-label {
            display: block;
            font-size: 0.82rem;
            color: var(--muted);
            margin-bottom: 0.4rem;
        }

        select {
            width: 100%;
         
            color: var(--text);
            border: 1px solid rgb(0 0 0 / 49%);
            border-radius: 14px;
            padding: 0.85rem 0.9rem;
            font-family: inherit;
            font-size: 0.95rem;
        }

        .action-row {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            flex-wrap: wrap;
            justify-content: right;
        }

        button {
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 14px;
            padding: 0.9rem 1.35rem;
            font-weight: 700;
            font-family: inherit;
            font-size: 0.95rem;
            cursor: pointer;
            transition: background 0.2s, transform 0.1s, opacity 0.2s;
        }

        button:hover {
            background: var(--primary-hover);
        }

        button:active {
            transform: scale(0.98);
        }

        button.secondary {
            background: rgba(148, 163, 184, 0.12);
            color: var(--text);
            border: 1px solid var(--border);
        }

        button.secondary:hover {
            background: rgba(148, 163, 184, 0.2);
        }

        .hint {
            color: var(--muted);
            font-size: 0.86rem;
        }

        .status-container {
            margin-top: 2rem;
            padding: 1rem;
            border-radius: 18px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border);
            display: none;
        }

        .badge {
            display: inline-block;
            padding: 0.28rem 0.78rem;
            border-radius: 9999px;
            font-size: 0.74rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-bottom: 0.8rem;
        }

        .badge.pending {
            background: rgba(234, 179, 8, 0.1);
            color: var(--pending);
        }

        .badge.processing {
            background: rgba(59, 130, 246, 0.1);
            color: var(--processing);
        }

        .badge.completed {
            background: rgba(34, 197, 94, 0.1);
            color: var(--completed);
        }

        audio {
            width: 100%;
            margin-top: 1rem;
            border-radius: 8px;
        }

        .footer-note {
            margin-top: 1rem;
            font-size: 1rem;
            line-height: 1.45;
        }

        @keyframes shake-animation {
            0%, 95% { transform: scale(1); }
            95.5% { transform: scale(1.05) rotate(-2deg); }
            96% { transform: scale(1.05) rotate(2deg); }
            96.5% { transform: scale(1.05) rotate(-1deg); }
            97% { transform: scale(1.05) rotate(1deg); }
            97.5% { transform: scale(1) rotate(0deg); }
            100% { transform: scale(1); }
        }

        .shake-interval {
            display: block;
            animation: shake-animation 10s infinite ease-in-out;
            transform-origin: center;
        }

        @media (max-width: 980px) {
            body {
                padding: 20px;
            }

            .layout {
                grid-template-columns: 1fr;
            }

            .samples-panel {
                max-height: none;
            }
        }
    </style>
</head>
<body>
    <div class="page">
        <div class="layout">
            <aside class="panel samples-panel">
                <div class="section-head">
                    <div>
                        <h2>Sample Texts</h2>
                    </div>
                    <div class="helper">Click any sample to load it</div>
                </div>

                <div class="sample-list" id="sampleList"></div>
            </aside>

            <div>
            <main class="panel main-panel">
                <h1>AWS Polly Voice Test</h1>
                <p class="subtitle">Convert text into voice using AWS Polly.  <a href="https://docs.aws.amazon.com/polly/latest/dg/what-is.html" target="_blank">What is AWS Polly?</a></p>
          

                <textarea id="textInput" placeholder="Enter text to synthesize..."></textarea>

                <div class="controls">
                    <div class="control-group">
                        <label class="control-label" for="voiceId">Supported Voices (English)</label>
                        <select id="voiceId">
                            <optgroup label="English (US)">
                                <option value="Joanna">Joanna (Female)</option>
                                <option value="Ivy">Ivy (Female)</option>
                                <option value="Kendra">Kendra (Female)</option>
                                <option value="Kimberly">Kimberly (Female)</option>
                                <option value="Salli">Salli (Female)</option>
                                <option value="Joey">Joey (Male)</option>
                                <option value="Kevin">Kevin (Male)</option>
                                <option value="Matthew">Matthew (Male)</option>
                            </optgroup>
                            <optgroup label="English (British)">
                                <option value="Amy">Amy (Female)</option>
                                <option value="Emma">Emma (Female)</option>
                                <option value="Brian">Brian (Male)</option>
                            </optgroup>
                            <optgroup label="English (Australian)">
                                <option value="Nicole">Nicole (Female)</option>
                                <option value="Russell">Russell (Male)</option>
                            </optgroup>
                            <optgroup label="English (Indian)">
                                <option value="Aditi">Aditi (Female)</option>
                                <option value="Raveena">Raveena (Female)</option>
                            </optgroup>
                            <optgroup label="English (Welsh)">
                                <option value="Geraint">Geraint (Male)</option>
                            </optgroup>
                        </select>
                    </div>

                    <div class="control-group" style="max-width: 180px;">
                        <label class="control-label" for="textType">Input Type</label>
                        <select id="textType">
                            <option value="text">Text</option>
                            <option value="ssml">SSML</option>
                        </select>
                    </div>
                </div>

                <div class="action-row">
                    <button id="submitBtn" onclick="synthesize()">Synthesize</button>
                    <button class="secondary" type="button" onclick="clearEditor()">Clear</button>
                </div>

                <div id="statusBox" class="status-container">
                    <div id="statusBadge" class="badge">PENDING</div>
                    <div id="statusText" style="font-size: 0.95rem;">Queueing request...</div>
                    <div id="playerArea"></div>
                </div>

                <div class="footer-note">
        
                <a href="https://docs.aws.amazon.com/polly/latest/dg/supportedtags.html" target="_blank">🔗‍<strong>AWS</strong> Polly Supported SSML tags</strong></a>
        
                </div>
               
            </main>
            <div class="shake-interval" style="text-align: center; font-weight: bold; font-size: 1.2rem; margin-top: 4rem;">Need AWS Expert? Find me on 🔗‍️ <a href="https://www.linkedin.com/in/dawita/" target="_blank">LinkedIn</a></div>
            </div>
        </div>
    </div>

    <script>
        let pollingInterval;

        const samples = [
            {
                title: "Executive Welcome Message",
                type: "text",
                content: "Welcome to the quarterly strategy review. Today we will cover business performance, customer growth, operating priorities, and the roadmap for the next two quarters."
            },
            {
                title: "Customer Support Response",
                type: "text",
                content: "Thank you for contacting our support team. We have received your request and a specialist will review your case shortly. We appreciate your patience and look forward to assisting you."
            },
            {
                title: "Financial Update Summary",
                type: "text",
                content: "Revenue increased by twelve percent year over year, while operating efficiency improved across fulfillment, support, and platform reliability initiatives."
            },
            {
                title: "Conference Opening Statement",
                type: "text",
                content: "Good morning, everyone. It is a pleasure to welcome you to our annual technology leadership summit. We are excited to share ideas, practical insights, and the innovations shaping the year ahead."
            },
            {
                title: "Pause and Emphasis Demo",
                type: "ssml",
                content: \`<speak>
                    Thank you for joining us today.
                    <break time="500ms"/>
                    We are <emphasis level="moderate">very pleased</emphasis> to announce the successful completion of phase one.
                    <break strength="strong"/>
                    Phase two begins next Monday.
                    </speak>\`
            },
            {
                title: "Prosody and Paragraph Structure",
                type: "ssml",
                content: \`<speak>
                    <p>
                        <s>Our objective is clear.</s>
                        <s><prosody rate="95%" pitch="+2%">We will improve delivery speed without compromising quality.</prosody></s>
                    </p>
                    <p>
                        <s><prosody volume="loud">Every team has a role in making this successful.</prosody></s>
                    </p>
                    </speak>\`
            },
            {
                title: "Date, Time, and Currency Rendering",
                type: "ssml",
                content: \`<speak>
                    The next review is scheduled for
                    <say-as interpret-as="date" format="mdy">04/15/2026</say-as>
                    at
                    <say-as interpret-as="time">2:30pm</say-as>.
                    The approved budget is
                    <say-as interpret-as="currency">$145000.75</say-as>.
                    </speak>\`
            },
            {
                title: "Abbreviation and Acronym Expansion",
                type: "ssml",
                content: \`<speak>
                    Our <sub alias="Chief Technology Officer">CTO</sub> will present the migration plan.
                    The system passed review by the <say-as interpret-as="characters">SOC</say-as> team,
                    and the new API meets all internal compliance requirements.
                    </speak>\`
            },
            {
                title: "Multilingual Phrase and Pronunciation Test",
                type: "ssml",
                content: \`<speak>
                    Our international launch includes support for the phrase
                    <lang xml:lang="fr-FR">bonjour et bienvenue</lang>.
                    We also tested the product name
                    <phoneme alphabet="ipa" ph="təˈmeɪtoʊ">tomato</phoneme>
                    for pronunciation consistency.
                    </speak>\`
            },
            {
                title: "Markers, DRC, and Part-of-Speech",
                type: "ssml",
                content: \`<speak>
                    <amazon:effect name="drc">
                        <mark name="intro-start"/>
                        Please record this message for the launch video.
                        We will <w role="amazon:VB">project</w> confidence,
                        clarity, and precision in every statement.
                        <break time="300ms"/>
                        Thank you for your attention.
                    </amazon:effect>
                    </speak>\`
            }
        ];

        function renderSamples() {
            const sampleList = document.getElementById('sampleList');

            sampleList.innerHTML = samples.map((sample, index) => \`
                <div class="sample-card" onclick="loadSample(\${index})">
                    <div class="sample-top">
                        <div class="sample-title">\${escapeHtml(sample.title)}</div>
                        <span class="chip \${sample.type}">\${sample.type === 'ssml' ? 'SSML' : 'Text'}</span>
                    </div>
                    <div class="sample-preview">\${escapeHtml(sample.content)}</div>
                </div>
            \`).join('');
        }

        function loadSample(index) {
            const sample = samples[index];
            document.getElementById('textInput').value = sample.content;
            document.getElementById('textType').value = sample.type;
        }

        function clearEditor() {
            document.getElementById('textInput').value = '';
            document.getElementById('playerArea').innerHTML = '';
            document.getElementById('statusBox').style.display = 'none';
        }

        function escapeHtml(value) {
            return value
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        async function synthesize() {
            const text = document.getElementById('textInput').value;
            const voiceId = document.getElementById('voiceId').value;
            const textType = document.getElementById('textType').value;
            const btn = document.getElementById('submitBtn');

            if (!text) {
                alert("Please enter some text");
                return;
            }

            btn.innerText = "Queuing...";
            btn.disabled = true;

            try {
                const response = await fetch('/Prod/synthesize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, voiceId, textType })
                });

                const data = await response.json();

                if (data.jobId) {
                    showStatus('PENDING', 'Job queued to SQS');
                    startPolling(data.jobId);
                } else {
                    throw new Error("Failed to secure Job ID");
                }
            } catch (err) {
                alert('Error: ' + err.message);
                btn.innerText = "Synthesize";
                btn.disabled = false;
            }
        }

        function startPolling(jobId) {
            if (pollingInterval) clearInterval(pollingInterval);

            pollingInterval = setInterval(async () => {
                try {
                    const response = await fetch('/Prod/status/' + jobId);
                    const data = await response.json();

                    showStatus(data.status, getStatusMessage(data.status));

                    if (data.status === 'COMPLETED' && data.audioUrl) {
                        clearInterval(pollingInterval);
                        const playerArea = document.getElementById('playerArea');
                        playerArea.innerHTML = '<audio controls autoplay src="' + data.audioUrl + '"></audio>';
                        document.getElementById('submitBtn').innerText = "Synthesize";
                        document.getElementById('submitBtn').disabled = false;
                    }
                } catch (err) {
                    console.error('Polling error:', err);
                }
            }, 2000);
        }

        function showStatus(status, message) {
            const box = document.getElementById('statusBox');
            const badge = document.getElementById('statusBadge');
            const text = document.getElementById('statusText');

            box.style.display = 'block';
            badge.innerText = status;
            badge.className = 'badge ' + status.toLowerCase();
            text.innerText = message;
        }

        function getStatusMessage(status) {
            if (status === 'PENDING') return 'Waiting in the SQS queue...';
            if (status === 'PROCESSING') return 'AWS Polly is synthesizing...';
            if (status === 'COMPLETED') return 'Audio file ready!';
            return status;
        }

        renderSamples();
        loadSample(0);
    </script>
</body>
</html>
    `;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: html
    };
};
