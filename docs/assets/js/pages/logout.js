// logout.php — drop the server-side session and the local copy, then go to login
(async () => {
  if (WP.session) await WP.api('logout');
  WP.clearSession();
  location.replace(WP.base + '/login.html');
})();
