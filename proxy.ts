import { auth } from "@/lib/auth.config";
import { NextResponse } from "next/server";

// Keep page navigation redirects in Proxy. API handlers perform their own
// auth checks so unauthenticated API clients receive JSON 401 responses.
export default auth((req) => {
  if (req.nextUrl.pathname.startsWith("/dashboard") && !req.auth?.user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: ["/dashboard/:path*"],
};
