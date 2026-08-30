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
//
// One name per surface. `/till` and `/account` were the first names for two of
// these and are gone rather than kept as aliases -- two paths reaching the same
// screen is the kind of thing that reads as a bug the first time somebody
// notices it, and there is nothing here worth that confusion.
const path = window.location.pathname;
const Entry = path.startsWith('/merchant')
  ? MerchantApp
  : path.startsWith('/user')
    ? UserApp
    : App;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Entry />
  </StrictMode>,
);
