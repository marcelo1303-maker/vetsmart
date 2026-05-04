// validators.js - Validação de dados para Horse Smart
export const validators = {
  nome: (value) => {
    if (!value || typeof value !== 'string') return false;
    const trimmed = value.trim();
    return trimmed.length >= 3 && trimmed.length <= 100 && /^[a-zA-ZÀ-ÿ\s'-]+$/.test(trimmed);
  },
  cpf: (value) => {
    if (!value) return false;
    const cleaned = value.replace(/\D/g, '');
    if (cleaned.length !== 11 || /^(\d)\1{10}$/.test(cleaned)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(cleaned[i]) * (10 - i);
    let rev = (sum * 10) % 11;
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cleaned[9])) return false;
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(cleaned[i]) * (11 - i);
    rev = (sum * 10) % 11;
    if (rev === 10 || rev === 11) rev = 0;
    return rev === parseInt(cleaned[10]);
  },
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
};

export const sanitize = {
  text: (v) => String(v).replace(/[<>]/g, '').trim().substring(0, 255)
};
