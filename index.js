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

    // Store the tokens
    await tokenHelpers.storeTokens({
      access_token,
      refresh_token,
      instance_url
    });

    console.log('✅ Tokens stored successfully');
    return res.send('Salesforce successfully connected!');
  } catch (error) {
    console.error('❌ Salesforce auth error:', {
      message: error.message,
      data: error.response?.data,
      status: error.response?.status
    });
    return res.status(500).send('Salesforce authentication failed. Check logs.');
  }
});

// Get employees from Salesforce
app.get('/api/employees', async (req, res) => {
  try {
    const tokens = await tokenHelpers.getTokens();
    if (!tokens) {
      return res.status(404).json({ error: 'No Salesforce connection found' });
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
          totalInPersonHours: 0
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

// Sync user data endpoint
app.post('/api/sync-user', async (req, res) => {
  try {
    const { id, name, clockRecords, totalRemoteHours, totalInPersonHours } = req.body;

    const tokens = await tokenHelpers.getTokens();
    if (!tokens) {
      return res.status(404).json({ error: 'No Salesforce connection found' });
    }

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
  const { userId, clockIn, clockOut, isRemote, timezone } = req.body;

  try {
    // Get the company tokens from the database
    const result = await pool.query('SELECT * FROM companies ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No company found in database' });
    }

    const company = result.rows[0];
    
    // Extract name from email (everything before @)
    const personName = userId.split('@')[0];
    
    // Parse the dates and ensure they're in the correct timezone
    const clockInDate = new Date(clockIn);
    const clockOutDate = clockOut ? new Date(clockOut) : null;
    
    // Format date as YYYY-MM-DD using the local time
    const dateStr = clockInDate.toLocaleDateString('en-US', { timeZone: timezone }).split(',')[0];
    
    // If clocking out, find and update the existing record
    if (clockOut) {
      // Query Salesforce for the most recent record for this user on this date
      const queryResponse = await axios.get(
        `${company.salesforce_instance_url}/services/data/v59.0/query`,
        {
          headers: {
            Authorization: `Bearer ${company.salesforce_access_token}`,
          },
          params: {
            q: `
              SELECT Id 
              FROM Workpunch__c 
              WHERE Employee_Email__c = '${userId}'
              AND Punch_In_Time__c = ${clockInDate.toISOString()}
              ORDER BY CreatedDate DESC 
              LIMIT 1
            `
          }
        }
      );

      if (queryResponse.data.records.length > 0) {
        // Update the existing record
        const recordId = queryResponse.data.records[0].Id;
        await axios.patch(
          `${company.salesforce_instance_url}/services/data/v59.0/sobjects/Workpunch__c/${recordId}`,
          {
            Punch_Out_Time__c: clockOutDate.toISOString()
          },
          {
            headers: {
              Authorization: `Bearer ${company.salesforce_access_token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        return res.status(200).json({ success: true, salesforceId: recordId });
      }
    }

    // If clocking in or no existing record found, create a new record
    const recordPayload = {
      Name: `${personName} - ${dateStr}`,
      Punch_In_Time__c: clockInDate.toISOString(),
      Punch_Out_Time__c: clockOutDate?.toISOString(),
      Location_Type__c: isRemote ? 'Remote' : 'In Office',
      Employee_Email__c: userId
    };

    const response = await axios.post(
      `${company.salesforce_instance_url}/services/data/v59.0/sobjects/Workpunch__c`,
      recordPayload,
      {
        headers: {
          Authorization: `Bearer ${company.salesforce_access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.status(200).json({ success: true, salesforceId: response.data.id });
  } catch (error) {
    console.error('Salesforce sync error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to sync to Salesforce' });
  }
});

// Salesforce connection endpoint
app.post('/api/connect-salesforce', async (req, res) => {
  console.log('🔗 Connect Salesforce endpoint hit');

  try {
    // Use fixed auth URL
    const authUrl = 'https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=3MVG9rZjd7MXFdLiWCf59z4DCGjghAZlWF7KXeBOX3mOvmrPJNArejq_0VHz1HuSTj.gZZ2KrlSLTekQYmEf8&redirect_uri=https%3A%2F%2Fworkpunch-server.fly.dev%2Fapi%2Fcallback&scope=api%20refresh_token';

    res.json({
      success: true,
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

  try {
    const tokens = await tokenHelpers.getTokens();
    
    if (!tokens || !tokens.access_token) {
      console.log('No valid connection found');
      return res.status(200).json({
        connected: false,
        message: 'Not connected to Salesforce'
      });
    }

    console.log('✅ Salesforce connection found');
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