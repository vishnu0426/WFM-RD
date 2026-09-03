import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, RenderOptions } from '@testing-library/react-native';
import { ReactElement, ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/auth/AuthContext';

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

/**
 * Mirrors app/_layout.tsx's real `Stack.Protected` route guard: a screen
 * under test should never actually mount before `AuthContext` resolves to
 * `authenticated`, exactly like production. Tests that need this call
 * `seedAuthenticatedSession()` (src/testing/mocks/authFixtures.ts) before
 * rendering, then `waitFor` past the brief bootstrapping gap.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status !== 'authenticated') {
    return null;
  }
  return <>{children}</>;
}

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 375, height: 812 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={createTestQueryClient()}>
        <AuthProvider>
          <AuthGate>{children}</AuthGate>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export * from '@testing-library/react-native';
