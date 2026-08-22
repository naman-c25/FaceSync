import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';
import { MerchantApp } from './merchant/MerchantApp.jsx';
import './styles.css';

// Two entry points, chosen by path. The customer kiosk and the merchant till
// have different audiences and different auth, and nothing in common but the
// camera — folding them into one screen would mean every customer-facing view
// carries code that can charge money.
const isMerchant = window.location.pathname.startsWith('/till');

createRoot(document.getElementById('root')).render(
  <StrictMode>{isMerchant ? <MerchantApp /> : <App />}</StrictMode>,
);
