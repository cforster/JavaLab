var flatiron = require('flatiron');
var app = flatiron.app;

var async = require('async');
var fs = require('fs');
var path = require('path');
var st = require('st');
var swig = require('swig');
var url = require('url');
var util = require('util');

var javaplayserver = require('./javaplayserver');

var labTemplate = swig.compile(String(fs.readFileSync('lab.html')));

app.config.file({ file: path.join(__dirname, 'config', 'config.json') });

app.use(flatiron.plugins.http);

if (flatiron.plugins.static) {
  app.use(flatiron.plugins.static, { root: __dirname });
} else if (flatiron.plugins.ecstatic) {
  app.use(flatiron.plugins.ecstatic, { root: __dirname });
} else {
  throw 'No static serving plugin found';
}

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
    var browserChannel = require('share/src/server/browserchannel');
    var browserChannelOptions = { server: app.server };
    var bcHandler = browserChannel(createAgent, browserChannelOptions);
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

app.router.get('/lab', function () {
  var app = this;
  var request = url.parse(this.req.url, true);
  var labName = request.query.labName || 'arrays2d';
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) {
      app.res.writeHead(200, {'Content-type': 'text/plain'});
      app.res.end('Unknown lab ' + labName + '\n' + String(e));
      return;
    }
    var lab = JSON.parse(data);
    async.map(lab.parts, function(f, done) {
      fs.readFile(path.join('labs', labName, f), done);
    }, function(e, results) {
      if (e) {
	app.res.writeHead(200, {'Content-type': 'text/plain'});
	app.res.end('Bad config for lab ' + labName + '\n' + String(e));
	return;
      }
      var parts = [];
      for (var i = 0; i < results.length; i++) {
	parts.push({'name': lab.parts[i], 'text': escape(results[i])});
      }
      var output = labTemplate({'parts': parts});
      app.res.writeHead(200, {'Content-type': 'text/html'});
      app.res.end(output);
    });
  });
});

app.start(app.config.get('httpPort'));
