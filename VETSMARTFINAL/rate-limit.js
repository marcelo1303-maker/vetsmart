// rate-limit.js — Express middleware de proteção contra brute force / abuso
// AVISO: Usa armazenamento em memória (Map). Em produção com múltiplas instâncias,
// o rate limit não é compartilhado entre processos. Para produção escalável,
// migrar para Redis. Defina PRODUCTION_SINGLE_INSTANCE=true para suprimir este aviso.
if (process.env.NODE_ENV === 'production' && !process.env.PRODUCTION_SINGLE_INSTANCE) {
    console.warn("⚠ AVISO: rate-limit.js usa armazenamento em memória (Map). Em produção com múltiplas instâncias, o rate limit não é compartilhado entre processos. Para produção escalável, migrar para Redis.");
}
const rateLimitStore = new Map();

function createRateLimiter({ windowMs = 60 * 1000, max = 60, message = 'Muitas requisições. Tente novamente mais tarde.' } = {}) {
    return function rateLimitMiddleware(req, res, next) {
        const key = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        const windowStart = now - windowMs;

        const history = (rateLimitStore.get(key) || []).filter(t => t > windowStart);
        if (history.length >= max) {
            return res.status(429).json({ error: message });
        }
        history.push(now);
        rateLimitStore.set(key, history);

        if (rateLimitStore.size > 10000) {
            for (const [k, times] of rateLimitStore) {
                if (times.every(t => t < windowStart)) rateLimitStore.delete(k);
            }
        }

        next();
    };
}

const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Muitas tentativas. Aguarde 15 minutos.' });
const paymentLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10, message: 'Muitas requisições de pagamento.' });

module.exports = { apiLimiter, authLimiter, paymentLimiter };
