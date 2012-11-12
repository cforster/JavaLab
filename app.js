var flatiron = require('flatiron');
var app = flatiron.app;

var fs = require('fs');
var path = require('path');
var shareClient = require('share').client;
var st = require('st');

var labserver = require('./labserver');

var labHtml = fs.readFileSync('app/assets/nglab.html');

app.config.argv().file({ file: path.join(__dirname, 'config', 'config.json') });

app.use(flatiron.plugins.http);
app.use(flatiron.plugins.static, { root: __dirname, url: '/assets' });

app.use(labserver);

var shareBroadwayPlugin = {
  'name': 'sharejs',
  'attach': function(options) {
    var sharePath = path.dirname(require.resolve('share'));
    var webclientPath = path.join(sharePath, 'webclient');
    this.http.before = this.http.before.concat(
      st({ path: webclientPath, url: '/share/' }));

    var bcPath = path.dirname(require.resolve('browserchannel'));
    var distPath = path.join(bcPath, 'dist');
    this.http.before = this.http.before.concat(
      st({ path: distPath, url: '/channeldist/' }));

    var options = { db: {type: 'mongo'} };
    var shareServer = require('share').server;
    var model = shareServer.createModel(options);

    var createAgent = require('share/src/server/useragent')(model, options);
    var sessionHandler = require('share/src/server/session').handler;
    var browserChannel = require('browserchannel').server;
    var browserChannelOptions = { server: app.server };
    var bcHandler = browserChannel(browserChannelOptions, function(session) {
      function wrapSession(s) {
        s.ready = function() { return this.state != 'closed'; };
        return s;
      }
      return sessionHandler(wrapSession(session), createAgent);
    });
    this.http.before = this.http.before.concat(function(req, res, next) {
      bcHandler(req.request, res.response, next);
    });
  },
  'detach': function() {},
  'init': function(done) {
    done();
  }
};
app.use(shareBroadwayPlugin);

app.router.get('/', function() {
  this.res.writeHead(200, {'Content-type': 'text/html'});
  this.res.end(labHtml);
});

app.start(app.config.get('httpPort'));
