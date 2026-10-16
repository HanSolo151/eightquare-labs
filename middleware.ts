import { auth } from "@/lib/auth.config";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isLoggedIn = !!req.auth?.user;
  const isProtected =
    req.nextUrl.pathname.startsWith("/dashboard") ||
    req.nextUrl.pathname.startsWith("/api/dashboard") ||
    req.nextUrl.pathname.startsWith("/api/patterns") ||
    req.nextUrl.pathname.startsWith("/api/sync") ||
    req.nextUrl.pathname.startsWith("/api/eval");

  if (isProtected && !isLoggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: ["/dashboard/:path*", "/api/dashboard/:path*", "/api/patterns/:path*", "/api/sync/:path*", "/api/eval/:path*"],
};
