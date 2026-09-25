import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import { MunicipalityProvider } from './lib/municipality.jsx';
import { ServiceProvider } from './lib/service.jsx';
import Root from './Root.jsx';
import './app.css';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <ServiceProvider>
      <MunicipalityProvider>
        <Root />
      </MunicipalityProvider>
    </ServiceProvider>
  </BrowserRouter>,
);
