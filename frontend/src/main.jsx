import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';
import { MerchantApp } from './merchant/MerchantApp.jsx';
import { UserApp } from './user/UserApp.jsx';
import './styles.css';

// Three entry points, chosen by path. The kiosk, the till and the portal have
// different audiences and different auth, and nothing in common but a
// stylesheet — folding them together would mean every customer-facing view
// carries code that can charge money.
//
// The kiosk is the default because it is the one a stranger walks up to.
const path = window.location.pathname;
const Entry = path.startsWith('/till')
  ? MerchantApp
  : path.startsWith('/account')
    ? UserApp
    : App;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
