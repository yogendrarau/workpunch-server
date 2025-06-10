require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { pool, tokenHelpers, initDb } = require('./db');
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

// Initialize database before starting the server
async function startServer() {
  try {
    console.log('Initializing database...');
    await initDb();
    console.log('Database initialized successfully');

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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

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

// OAuth callback endpoint
app.get('/api/callback', async (req, res) => {
  console.log('🔔 Callback endpoint hit - START');
  console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
  console.log('Raw query string:', req.url.split('?')[1]);
  console.log('Query params:', req.query);
  console.log('Headers:', req.headers);
  
  const { code } = req.query;

  if (!code) {
    console.error('No authorization code received');
    return res.status(400).send('Authorization code is missing');
  }

  try {
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

    // Get the most recently created organization code
    const organizationCode = await tokenHelpers.getLatestOrganizationCode();
    console.log('Latest organization code:', organizationCode);

    if (!organizationCode) {
      console.log('No organization code found, creating new one...');
      const newOrganizationCode = `org_${Date.now()}`;
      const defaultCompanyName = 'Default Company';
      const defaultDomain = 'default.com';

      await tokenHelpers.storeTokens(
        defaultCompanyName,
        defaultDomain,
        newOrganizationCode,
        {
          access_token,
          refresh_token,
          instance_url
        }
      );

      console.log('✅ Created new organization with code:', newOrganizationCode);
      return res.send(`Salesforce successfully connected! Your organization code is: ${newOrganizationCode}`);
    }

    // Get company info from the database
    const companyInfo = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    if (!companyInfo) {
      console.error('❌ No company info found for organization code:', organizationCode);
      return res.status(500).send('Company information not found');
    }

    // Store the tokens
    await tokenHelpers.storeTokens(
      companyInfo.companyName,
      companyInfo.companyDomain,
      organizationCode,
      {
        access_token,
        refresh_token,
        instance_url
      }
    );

    console.log('✅ Tokens stored successfully for organization:', organizationCode);
    return res.send(`Salesforce successfully connected! Your organization code is: ${organizationCode}`);
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

// Get company info by organization code
app.get('/api/company/:organizationCode', async (req, res) => {
  try {
    const { organizationCode } = req.params;
    const tokens = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    
    if (!tokens) {
      return res.status(404).json({ error: 'Company not found for this organization' });
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
    const { id, name, clockRecords, totalRemoteHours, totalInPersonHours, organizationCode } = req.body;

    const tokens = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    if (!tokens) return res.status(404).json({ error: 'Company not authorized for this organization' });

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
  const { userId, clockIn, clockOut, isRemote, organizationCode } = req.body;

  try {
    const tokens = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    if (!tokens) return res.status(404).json({ error: 'Company not authorized for this organization' });

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

// Salesforce connection endpoint
app.post('/api/connect-salesforce', async (req, res) => {
  console.log('🔗 Connect Salesforce endpoint hit');
  console.log('Request body:', req.body);

  const { companyDomain } = req.body;

  if (!companyDomain) {
    console.error('Missing required field:', { companyDomain });
    return res.status(400).json({ error: 'Missing required field: companyDomain' });
  }

  try {
    // Generate organization code from timestamp
    const organizationCode = `org_${Date.now()}`;
    
    // Store initial company record
    await tokenHelpers.storeTokens(
      companyDomain.split('.')[0], // Use domain prefix as company name
      companyDomain,
      organizationCode,
      {
        access_token: null,
        refresh_token: null,
        instance_url: null
      }
    );

    // Use fixed auth URL
    const authUrl = 'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=3MVG9rZjd7MXFdLiWCf59z4DCGjghAZlWF7KXeBOX3mOvmrPJNArejq_0VHz1HuSTj.gZZ2KrlSLTekQYmEf8&redirect_uri=https%3A%2F%2Fworkpunch-server.fly.dev%2Fapi%2Fcallback&scope=api%20refresh_token';

    console.log('Organization code:', organizationCode);

    res.json({
      success: true,
      organizationCode: organizationCode,
      authUrl: authUrl
    });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

// Verify Salesforce connection status
app.get('/api/verify-salesforce-connection', async (req, res) => {
  console.log('🔍 Verify Salesforce connection endpoint hit');
  const { organizationCode, companyDomain } = req.query;

  if (!organizationCode || !companyDomain) {
    console.error('Missing required parameters');
    return res.status(400).json({
      connected: false,
      message: 'Organization code and company domain are required'
    });
  }

  try {
    const tokens = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    
    if (!tokens || tokens.companyDomain !== companyDomain) {
      console.log('No valid connection found for organization:', organizationCode);
      return res.status(200).json({
        connected: false,
        message: 'Not connected to Salesforce'
      });
    }

    console.log('✅ Salesforce connection found for organization:', organizationCode);
    return res.status(200).json({
      connected: true,
      message: 'Connected to Salesforce'
    });
  } catch (error) {
    console.error('Error checking Salesforce connection:', error);
    return res.status(500).json({
      connected: false,
      message: 'Error checking connection'
    });
  }
});

// Get employees from Salesforce
app.get('/api/employees', async (req, res) => {
  const { organizationCode, companyDomain } = req.query;

  if (!organizationCode || !companyDomain) {
    return res.status(400).json({ error: 'Organization code and company domain are required' });
  }

  try {
    const tokens = await tokenHelpers.getTokensByOrganizationCode(organizationCode);
    if (!tokens || tokens.companyDomain !== companyDomain) {
      return res.status(404).json({ error: 'Company not authorized for this organization' });
    }

    // Query Salesforce for employees and their clock records
    const response = await axios.get(
      `${tokens.instance_url}/services/data/v59.0/query`,
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
        params: {
          q: `
            SELECT 
              Employee_Email__c,
              Employee_Name__c,
              Punch_In_Time__c,
              Punch_Out_Time__c,
              Location_Type__c
            FROM Workpunch__c
            ORDER BY Employee_Email__c, Punch_In_Time__c DESC
          `
        }
      }
    );

    // Group records by employee
    const employeeMap = new Map();
    response.data.records.forEach(record => {
      if (!employeeMap.has(record.Employee_Email__c)) {
        employeeMap.set(record.Employee_Email__c, {
          id: record.Employee_Email__c,
          name: record.Employee_Name__c,
          clockRecords: [],
          totalRemoteHours: 0,
          totalInPersonHours: 0,
          organizationCode: organizationCode
        });
      }

      const employee = employeeMap.get(record.Employee_Email__c);
      if (record.Punch_In_Time__c) {
        const clockRecord = {
          clockIn: new Date(record.Punch_In_Time__c),
          clockOut: record.Punch_Out_Time__c ? new Date(record.Punch_Out_Time__c) : null,
          isRemote: record.Location_Type__c === 'Remote'
        };
        employee.clockRecords.push(clockRecord);

        // Calculate hours if clocked out
        if (clockRecord.clockOut) {
          const hours = (clockRecord.clockOut - clockRecord.clockIn) / (1000 * 60 * 60);
          if (clockRecord.isRemote) {
            employee.totalRemoteHours += hours;
          } else {
            employee.totalInPersonHours += hours;
          }
        }
      }
    });

    res.json(Array.from(employeeMap.values()));
  } catch (error) {
    console.error('Error fetching employees from Salesforce:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch employees from Salesforce' });
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

// Start the server
startServer();