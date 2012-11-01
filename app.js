var flatiron = require('flatiron');
var app = flatiron.app;

var async = require('async');
var connect = require('connect');
var fs = require('fs');
var path = require('path');
var st = require('st');
var swig = require('swig');
var url = require('url');
var util = require('util');

var javaplayserver = require('./javaplayserver');

var labTemplate = swig.compile(String(fs.readFileSync('lab.html')));
var labsTemplate = swig.compile(String(fs.readFileSync('labs.html')));
var loginTemplate = swig.compile(String(fs.readFileSync('login.html')));


app.config.file({ file: path.join(__dirname, 'config', 'config.json') });

app.use(flatiron.plugins.http);
app.use(flatiron.plugins.static, { root: __dirname, url: '/assets' });

app.use(javaplayserver);

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

    var options = { db: {type: 'none'} };
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

app.http.before.push(connect.cookieParser());
app.http.before.push(connect.session({secret:'gumpdrops'}));

app.router.get('/', function(){
  var output = loginTemplate({ });
  this.res.writeHead(200, {'Content-type': 'text/html'});
  this.res.end(output);
});

app.router.post('/', function() {
  var user = this.req.body['user'];
  if (!user) {
    info.res.writeHead(200, {'Content-type': 'text/plain'});
    info.res.end('tried login with no user');
    return;             
  }
  this.req.session.user = user;
  labsHandler(this);
});

app.router.get('/logout', function() {
  var info = this;
  info.req.session.destroy(function(e){ info.res.end('ok', 200); });
  info.res.redirect('/');
});

function labsHandler(info) {
  if (info.req.session.user == null) {
    // if user is not logged-in redirect back to login page //
    info.res.redirect('/');
  } else {
    fs.readdir('labs', function(e, files) {
      if (e) {
        info.res.writeHead(200, {'Content-type': 'text/plain'});
        info.res.end('labs folder not found\n' + String(e));
        return;         
      }
      var output = labsTemplate({'labs':files});
      info.res.writeHead(200, {'Content-type': 'text/html'});
      info.res.end(output);
    });
  }
}
app.router.get('/labs', function() { labsHandler(this); });

app.router.get(/\/lab\/:labName/, function (labName) {
  var info = this;
  if (info.req.session.user == null){
    // if user is not logged-in redirect back to login page //
    info.res.redirect('/');
  } else {
    var request = url.parse(info.req.url, true);
    fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
      if (e) {
        info.res.writeHead(200, {'Content-type': 'text/plain'});
        info.res.end('Unknown lab ' + labName + '\n' + String(e));
        return;
      }
      var lab = JSON.parse(data);
      async.map(lab.parts, function(f, done) {
        fs.readFile(path.join('labs', labName, f), done);
      }, function(e, results) {
        if (e) {
          info.res.writeHead(200, {'Content-type': 'text/plain'});
          info.res.end('Bad config for lab ' + labName + '\n' + String(e));
          return;
        }
        var parts = [];
        for (var i = 0; i < results.length; i++) {
          parts.push({'name': lab.parts[i], 'text': escape(results[i])});
        }
        var output = labTemplate({'parts': parts,
                                  'user': info.req.session.user});
        info.res.writeHead(200, {'Content-type': 'text/html'});
        info.res.end(output);
      });
    });
  }   
});

app.start(app.config.get('httpPort'));         

