// Import Navigate from React Router.
//
// Navigate is used to redirect the user
// from one page to another.
import { Navigate } from "react-router-dom";


// Import useAuth from AuthContext.
//
// useAuth gives us:
// - user   → currently logged-in user
// - loading → tells us whether authentication
//             checking is still in progress
import { useAuth } from "../context/AuthContext";
import BlockedSession from "./BlockedSession";


// ProtectedRoute component.
//
// This component protects private pages.
//
// Example of private pages:
// - Organizations
// - Projects
// - Tasks
//
// Only logged-in users can access these pages.
export default function ProtectedRoute({ children }) {

  const auth = useAuth();
  if (!auth) {
    return <Navigate to="/login" replace />;
  }

  // Get user and loading information
  // from AuthContext.
  const { user, loading, sessionLocked } = auth;


  // ======================================================
  // CHECK AUTHENTICATION LOADING
  // ======================================================

  // If the application is still checking
  // whether the user is logged in,
  // show a loading message.
  //
  // This prevents the app from redirecting
  // before authentication checking is finished.
  if (loading) {
    return (
      <div className="screen-loader">
        Loading workspace...
      </div>
    );
  }

  if (sessionLocked) {
    return <BlockedSession />;
  }


  // ======================================================
  // CHECK IF USER IS LOGGED IN
  // ======================================================

  // If there is no user,
  // the user is NOT logged in.
  //
  // Redirect the user to the login page.
  if (!user) {
    return <Navigate to="/login" replace />;
  }


  // ======================================================
  // USER IS AUTHENTICATED
  // ======================================================

  // If a user exists,
  // allow the protected page to be displayed.
  return children;
}