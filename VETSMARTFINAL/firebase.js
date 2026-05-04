import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// --- Configuração da URL Base para chamadas ao backend ---
// Usa sempre a origem atual do browser, eliminando a necessidade de hardcodar domínios.
export const BASE_URL = window.location.origin;

// Configuração do Firebase para o frontend
const firebaseConfig = {
  apiKey: "AIzaSyDgp1IN6Bl4_lvlTfihlXYktmrH-rIZUDY",
  authDomain: "vetsmart-11674145-f2ba3.firebaseapp.com",
  projectId: "vetsmart-11674145-f2ba3",
  storageBucket: "horsesmart.firebasestorage.app",
  messagingSenderId: "369544605442",
  appId: "1:369544605442:web:bdcd45ecf0d2605c0b9c1b",
  measurementId: "G-DRBE8NE5C0"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app, "horsesmart");
export const storage = getStorage(app);
