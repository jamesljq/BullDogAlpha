/** @jest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

describe('Bulldog Alpha Web Console', () => {
  let wsSpy: jest.Mock;
  let originalWebSocket: any;
  let originalLocation: Location;

  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    originalWebSocket = (global as any).WebSocket;
    originalLocation = window.location;
  });

  afterAll(() => {
    (global as any).WebSocket = originalWebSocket;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  beforeEach(() => {
    wsSpy = jest.fn().mockImplementation(() => ({
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
    }));
    (global as any).WebSocket = wsSpy;

    // Mock window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        protocol: 'http:',
        host: 'localhost:3000',
        hostname: 'localhost',
        port: '3000',
        pathname: '/',
      },
    });
  });

  test('renders dashboard header and circuit status', () => {
    render(<App />);
    
    // Verify branding title
    expect(screen.getByText("BULLDOG")).toBeInTheDocument();
    expect(screen.getByText("ALPHA")).toBeInTheDocument();
    
    // Verify health topology section
    expect(screen.getByText(/Microservices Health & Topology/i)).toBeInTheDocument();
  });

  test('establishes WebSocket connection with correct relative URL', () => {
    render(<App />);
    
    // App should connect via relative path under port 3000 (proxied to 8080 by Vite)
    expect(wsSpy).toHaveBeenCalledWith('ws://localhost:3000/ws');
  });
});
