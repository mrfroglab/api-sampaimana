const env = require('./config/env');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const openapi = require('./docs/openapi');
const { errorHandler, notFoundHandler } = require('./lib/http');
const { apiLimiter } = require('./middlewares/rateLimit');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY);

app.use(
  helmet({
    // Swagger UI needs inline styles/scripts on /api/docs only; the API itself serves JSON.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);
app.use(
  cors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }),
);
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(cookieParser());

app.get('/', (req, res) => res.redirect('/api/docs'));
app.use('/api', apiLimiter);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'Sampai Mana API' }));
app.get('/api/openapi.json', (req, res) => res.json(openapi));

app.use('/api', require('./modules/meta'));
app.use('/api/auth', require('./modules/auth'));
app.use('/api/cases', require('./modules/cases'));
app.use('/api/me', require('./modules/account'));
app.use('/api/admin', require('./modules/admin'));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
