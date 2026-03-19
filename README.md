# Sentinel v2 - Project Intelligence Platform

Sentinel is a real-time project auditing tool that cross-references ClickUp tasks, 
technical documentation, and Git logs using AI (Groq + Llama 3.1).

## 🚀 Quick Start
1. `npm install`
2. Create a `.env` file and add `VITE_GROQ_KEY=your_key_here`
3. `npm run dev`

## 🧠 Core Logic
- **Anomaly Detector:** Uses Llama 3.1 to find mismatches between ClickUp (JSON) and Docs (Text).
- **Connectors:** Live sync with ClickUp API v2.
- **Multi-tenant:** Demo accounts for Admin, PM, HR, Finance, and Clients.

## 🛠 Tech Stack
- React (Hooks & Context)
- Groq Cloud API (Llama 3.1 8b)
- ClickUp API v2
- CSS-in-JS (Standardized object styles)
