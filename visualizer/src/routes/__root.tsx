import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { ConvexProvider } from "convex/react";
import { convex } from "../lib/convex";
import { AppSidebar } from "../lib/AppSidebar";
import { AppTopBar } from "../lib/AppTopBar";

import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Convex Evaluation Visualizer" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isHome = pathname === "/" || pathname === "";
  const isDecision =
    pathname === "/decision" || pathname.startsWith("/decision/");

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-slate-900 text-slate-100 min-h-screen">
        <ConvexProvider client={convex}>
          <div className="flex flex-col h-screen">
            <AppTopBar />
            <div className="flex flex-1 min-h-0">
              {!isHome && !isDecision && <AppSidebar />}
              <Outlet />
            </div>
          </div>
        </ConvexProvider>
        <Scripts />
      </body>
    </html>
  );
}
