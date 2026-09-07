'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { BookOpen, Database } from 'lucide-react';
import { useStudio } from '@/lib/store';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LangToggle } from '@/components/lang-toggle';
import { UserMenu } from '@/components/settings/user-menu';
import { ConnectionDialog } from '@/components/connections/connection-dialog';
import { BridgesView } from '@/components/bridges/bridges-view';
import { BridgeList } from '@/components/bridges/bridge-list';
import { BridgeBuilder } from '@/components/bridges/bridge-builder';
import { DataSourcesManager } from '@/components/data-sources-manager';
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher';

/**
 * the app is a bridges workspace. sidebar lists bridges, main panel shows the
 * selected bridge's jobs. connecting, browsing tables and DDL live in the Data
 * Sources surface and the Bridge Builder. data sources exist to feed bridges.
 */
export function Studio() {
  const t = useTranslations('nav');
  const {
    selectedBridgeId,
    selectBridge,
    dataSourcesOpen,
    openDataSources,
    bridgeEditor,
    openBridgeEditor,
  } = useStudio();

  // restore UI state from the URL on load and keep the URL in sync, so a
  // refresh keeps you on the same bridge/surface instead of bouncing to root
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const bridge = p.get('bridge');
    if (bridge) selectBridge(bridge);
    if (p.get('data') === '1') openDataSources();
    const edit = p.get('edit');
    if (edit) openBridgeEditor({ editingId: edit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (selectedBridgeId) p.set('bridge', selectedBridgeId);
    if (dataSourcesOpen) p.set('data', '1');
    if (bridgeEditor.open && bridgeEditor.editingId)
      p.set('edit', bridgeEditor.editingId);
    const qs = p.toString();
    window.history.replaceState(
      null,
      '',
      qs ? `?${qs}` : window.location.pathname,
    );
  }, [selectedBridgeId, dataSourcesOpen, bridgeEditor.open, bridgeEditor.editingId]);

  return (
    <>
      <ResizablePanelGroup direction="horizontal" className="h-screen">
        {/* sidebar, bridges only */}
        <ResizablePanel defaultSize={22} minSize={16} maxSize={32}>
          <div className="flex h-full flex-col border-r">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div className="flex items-center">
                {/* dark artwork in light mode, white artwork in dark mode */}
                <Image
                  src="/logo-dark.png"
                  alt="Syncle"
                  width={747}
                  height={412}
                  priority
                  className="h-7 w-auto dark:hidden"
                />
                <Image
                  src="/logo-white.png"
                  alt="Syncle"
                  width={747}
                  height={412}
                  priority
                  className="hidden h-7 w-auto dark:block"
                />
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t('dataSources')}
                  onClick={openDataSources}
                >
                  <Database className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                  <a
                    href="https://syncle.dev/docs"
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t('docs')}
                    aria-label={t('docs')}
                  >
                    <BookOpen className="h-4 w-4" />
                  </a>
                </Button>
                <ThemeToggle />
                <LangToggle />
                <UserMenu />
              </div>
            </div>
            <Separator />
            {/* which workspace you're in — scopes the bridges + connections below */}
            <div className="px-2 py-1.5">
              <WorkspaceSwitcher />
            </div>
            <Separator />
            <BridgeList />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* main, the bridges workspace */}
        <ResizablePanel defaultSize={78}>
          <BridgesView />
        </ResizablePanel>
      </ResizablePanelGroup>

      <ConnectionDialog />
      <BridgeBuilder />
      <DataSourcesManager />
    </>
  );
}
