import { lazy } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { MotionProvider } from "./components/site/motion";
import { SiteLayout } from "./components/site/Layout";
import { ViewerProvider } from "./hooks/viewer";

const Home = lazy(() => import("./pages/Home"));
const HowItWorks = lazy(() => import("./pages/HowItWorks"));
const IndexPage = lazy(() => import("./pages/IndexPage"));
const BuiltOn = lazy(() => import("./pages/BuiltOn"));
const Market = lazy(() => import("./pages/Market"));
const AppPage = lazy(() => import("./pages/AppPage"));
const EvidencePage = lazy(() => import("./pages/EvidencePage"));
const About = lazy(() => import("./pages/About"));
const Roadmap = lazy(() => import("./pages/Roadmap"));
const NotFound = lazy(() => import("./pages/NotFound"));

export function App() {
  return (
    <MotionProvider>
      <ViewerProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<SiteLayout />}>
              <Route index element={<Home />} />
              <Route path="how-it-works" element={<HowItWorks />} />
              <Route path="index" element={<IndexPage />} />
              <Route path="built-on" element={<BuiltOn />} />
              <Route path="market" element={<Market />} />
              <Route path="app" element={<AppPage />} />
              <Route path="evidence" element={<EvidencePage />} />
              <Route path="about" element={<About />} />
              <Route path="roadmap" element={<Roadmap />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ViewerProvider>
    </MotionProvider>
  );
}
