require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { db, tokenHelpers } = require('./db');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Health check endpoint
app.get('/', (req, res) => res.send('Workpunch backend is live!'));

// Token management endpoints
app.post('/api/tokens', async (req, res) => {
  try {
    const { company_name, access_token, refresh_token, instance_url } = req.body;
    
    if (!company_name || !access_token || !refresh_token || !instance_url) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await tokenHelpers.storeTokens(company_name, {
      access_token,
      refresh_token,
      instance_url
    });

    res.status(200).json({ message: 'Tokens stored successfully' });
  } catch (error) {
    console.error('Error storing tokens:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/tokens/:companyName', async (req, res) => {
  try {
    const { companyName } = req.params;
    const tokens = await tokenHelpers.getTokens(companyName);
    
    if (!tokens) {
      return res.status(404).json({ error: 'Company not found or tokens invalid' });
    }

    res.status(200).json(tokens);
  } catch (error) {
    console.error('Error retrieving tokens:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/tokens/:companyName', async (req, res) => {
  try {
    const { companyName } = req.params;
    const result = await tokenHelpers.invalidateTokens(companyName);
    
    if (result === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.status(200).json({ message: 'Tokens invalidated successfully' });
  } catch (error) {
    console.error('Error invalidating tokens:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});