require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { db, tokenHelpers } = require('./db');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Process level error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Keep the process running
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Keep track of server state
let serverState = {
  startTime: null,
  requestCount: 0,
  lastRequest: null
};

const app = express();

// Debug middleware - log ALL requests before any other middleware
app.use((req, res, next) => {
  serverState.requestCount++;
  serverState.lastRequest = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Request #${serverState.requestCount}:`, {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    query: req.query,
    headers: req.headers
  });
  next();
});

// Trust proxy for rate limiter
app.set('trust proxy', 1);

// Security middleware - temporarily disable helmet for testing
// app.use(helmet({
//   crossOriginResourcePolicy: { policy: "cross-origin" },
//   crossOriginOpenerPolicy: { policy: "unsafe-none" }
// }));

app.use(cors({
  origin: '*',  // Allow all origins temporarily for testing
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Rate limiting - temporarily disable for testing
// app.use(limiter);

// Health check endpoints
app.get('/', (req, res) => {
  console.log('Root endpoint hit');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    serverState: {
      startTime: serverState.startTime,
      requestCount: serverState.requestCount,
      lastRequest: serverState.lastRequest
    }
  });
});

app.get('/ping', (req, res) => {
  console.log('✅ /ping route was hit');
  res.send('Pong!');
});

// Debug route to test routing
app.get('/api/test', (req, res) => {
  console.log('Test route hit');
  res.send('Test route working');
});

// OAuth callback endpoint - moved before other routes for testing
app.get('/api/callback', async (req, res) => {
  console.log('🔔 Callback endpoint hit - START');
  console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
  console.log('Query params:', req.query);
  console.log('Headers:', req.headers);
  
  const { code, state } = req.query;

  if (!code) {
    console.error('No authorization code received');
    return res.status(400).send('Authorization code is missing');
  }

  if (!state) {
    console.error('No state parameter received');
    return res.status(400).send('State parameter is missing. Please try the authorization flow again.');
  }

  try {
    // Parse state parameter to get tenant ID and company name
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (parseError) {
      console.error('Failed to parse state parameter:', parseError);
      return res.status(400).send('Invalid state parameter. Please try the authorization flow again.');
    }

    const { tenantId, companyName } = stateData;

    if (!tenantId || !companyName) {
      console.error('Missing tenant ID or company name in state:', stateData);
      return res.status(400).send('Invalid state data. Please try the authorization flow again.');
    }

    const tokenRequestParams = {
      grant_type: 'authorization_code',
      client_id: process.env.SALESFORCE_CLIENT_ID,
      client_secret: process.env.SALESFORCE_CLIENT_SECRET,
      redirect_uri: process.env.SALESFORCE_REDIRECT_URI,
      code
    };

    console.log('📡 Requesting tokens from Salesforce...');

    const response = await axios.post('https://login.salesforce.com/services/oauth2/token', null, {
      params: tokenRequestParams
    });

    const { access_token, refresh_token, instance_url } = response.data;

    if (!access_token || !refresh_token || !instance_url) {
      console.error('❌ Missing tokens from response:', response.data);
      return res.status(500).send('Invalid response from Salesforce');
    }

    console.log('💾 Storing tokens in DB...');
    await tokenHelpers.storeTokens(companyName, tenantId, {
      access_token,
      refresh_token,
      instance_url
    });

    console.log('✅ Tokens stored successfully for company:', companyName);
    return res.send('Salesforce successfully connected! You can close this window.');
  } catch (error) {
    console.error('❌ Salesforce auth error:', {
      message: error.message,
      data: error.response?.data,
      status: error.response?.status
    });
    return res.status(500).send('Salesforce authentication failed. Check logs.');
  }
});

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

// Get company info by tenant ID
app.get('/api/company/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tokens = await tokenHelpers.getTokensByTenantId(tenantId);
    
    if (!tokens) {
      return res.status(404).json({ error: 'Company not found for this tenant' });
    }

    res.status(200).json(tokens);
  } catch (error) {
    console.error('Error retrieving company info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync user data endpoint
app.post('/api/sync-user', async (req, res) => {
  try {
    const { id, name, clockRecords, totalRemoteHours, totalInPersonHours, tenantId } = req.body;

    const tokens = await tokenHelpers.getTokensByTenantId(tenantId);
    if (!tokens) return res.status(404).json({ error: 'Company not authorized for this tenant' });

    // Sync each clock record to Salesforce
    for (const record of clockRecords) {
      const recordPayload = {
        Punch_In_Time__c: record.clockIn,
        Punch_Out_Time__c: record.clockOut,
        Location_Type__c: record.isRemote ? 'Remote' : 'In Office',
        Employee_Email__c: id
      };

      await axios.post(`${tokens.instance_url}/services/data/v59.0/sobjects/Workpunch__c`, recordPayload, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json'
        }
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error syncing user data:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to sync user data to Salesforce' });
  }
});

// Sync individual clock record endpoint
app.post('/api/sync-clock', async (req, res) => {
  const { userId, clockIn, clockOut, isRemote, tenantId } = req.body;

  try {
    const tokens = await tokenHelpers.getTokensByTenantId(tenantId);
    if (!tokens) return res.status(404).json({ error: 'Company not authorized for this tenant' });

    const recordPayload = {
      Punch_In_Time__c: clockIn,
      Punch_Out_Time__c: clockOut,
      Location_Type__c: isRemote ? 'Remote' : 'In Office',
      Employee_Email__c: userId
    };

    const response = await axios.post(`${tokens.instance_url}/services/data/v59.0/sobjects/Workpunch__c`, recordPayload, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    res.status(200).json({ success: true, salesforceId: response.data.id });
  } catch (error) {
    console.error('Salesforce sync error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to sync to Salesforce' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  res.status(500).json({ error: 'Something broke!' });
});

// 404 handler - must be after all other routes
app.use((req, res) => {
  console.log('404 Not Found:', {
    method: req.method,
    url: req.url,
    path: req.path,
    originalUrl: req.originalUrl,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
  res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  serverState.startTime = new Date().toISOString();
  console.log(`[${serverState.startTime}] Server is running on port ${PORT}`);
  console.log('Available routes:');
  console.log('GET  /');
  console.log('GET  /ping');
  console.log('GET  /api/test');
  console.log('GET  /api/callback');
});

// Handle server errors
server.on('error', (error) => {
  console.error('Server error:', error);
});

// Handle server close
server.on('close', () => {
  console.log('Server is shutting down...');
});