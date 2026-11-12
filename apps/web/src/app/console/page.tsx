import type { Metadata } from "next";

import { Console } from "@/components/console/Console";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = { title: "Console" };

export default function ConsolePage() {
  return (
    <>
      <Nav page="console" />
      <Console />
    </>
  );
}
