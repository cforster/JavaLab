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

<<<<<<< Updated upstream
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

app.router.get('/lab', function () {
  var app = this;
  var request = url.parse(this.req.url, true);
  var labName = request.query.labName || 'arrays2d';
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) {
      app.res.writeHead(200, {'Content-type': 'text/plain'});
      app.res.end('Unknown lab ' + labName + '\n' + String(e));
      return;
=======
app.router.get('/', function(){
    //render login.html
});

app.router.post('/', function() {
    req.session.user = req.param('user');
    res.redirect('/labs');
});

app.router.get('/logout', function() {
    req.session.destroy(function(e){ res.send('ok', 200); });
    res.redirect('/');
});

app.router.get('/labs', function() {
    if (req.session.user == null){
	// if user is not logged-in redirect back to login page //
	res.redirect('/');
    } 
    else
    {
	//render the labs page
	//needs labs list with lab.name is the name of the lab
	//lab.ref is a name with no spaces
>>>>>>> Stashed changes
    }
});

<<<<<<< Updated upstream
app.start(app.config.get('httpPort'));
=======
//change to takes labs/[labname]
app.router.get('/lab', function () {
    if (this.req.session.user == null){
	// if user is not logged-in redirect back to login page //
	app.res.redirect('/');
    } 
    else
    {
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
    }   
});
	       
app.start(80);
	       
>>>>>>> Stashed changes
