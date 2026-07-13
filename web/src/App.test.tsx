import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import App from './App';

test('renders dashboard header and circuit status', () => {
  render(<App />);
  
  // Verify branding title
  const brandTitle = screen.getByText(/BULLDOG/i);
  expect(brandTitle).toBeInTheDocument();
  
  const brandSub = screen.getByText(/ALPHA/i);
  expect(brandSub).toBeInTheDocument();

  // Verify health topology section
  const topologyHeader = screen.getByText(/Microservices Health & Topology/i);
  expect(topologyHeader).toBeInTheDocument();

  // Verify OOB Command Buttons
  const pauseBtn = screen.getByText(/PAUSE TRADING/i);
  expect(pauseBtn).toBeInTheDocument();

  const panicBtn = screen.getByText(/PANIC LIQUIDATE/i);
  expect(panicBtn).toBeInTheDocument();
});
