require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Sos el asistente virtual del gimnasio Hockey Vivo en Santiago del Estero, Argentina. Atendés consultas de clientes sobre horarios, turnos y pagos. Respondés en español argentino, de forma amable y breve. Si no sabés algo, decís que lo vas a consultar con el equipo.`;

app.post('/webhook', async (req, res) => {
  try {
    console.log('req.body completo:', req.body);
    const mensaje = req.body.Body;
    const remitente = req.body.From;

    console.log(`Mensaje recibido de ${remitente}: ${mensaje}`);

    const respuestaClaude = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: mensaje }],
    });

    const texto = respuestaClaude.content[0].text;
    console.log(`Respuesta de Claude: ${texto}`);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(texto);

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error en webhook:', error);
    res.status(500).send('Error interno del servidor');
  }
});

app.listen(3000, () => {
  console.log('Servidor escuchando en puerto 3000');
});
