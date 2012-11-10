var flatiron = require('flatiron');
var app = flatiron.app;

var async = require('async');
var connect = require('connect');
var fs = require('fs');
var mongo = require('mongodb');
var path = require('path');
var shareClient = require('share').client;
var st = require('st');
var swig = require('swig');
var url = require('url');
var util = require('util');

var javaplayserver = require('./javaplayserver');
var labserver = require('./labserver');

var labTemplate = swig.compile(String(fs.readFileSync('lab.html')));
var labsTemplate = swig.compile(String(fs.readFileSync('labs.html')));
var loginTemplate = swig.compile(String(fs.readFileSync('login.html')));


app.config.argv().file({ file: path.join(__dirname, 'config', 'config.json') });

app.use(flatiron.plugins.http);
app.use(flatiron.plugins.static, { root: __dirname, url: '/assets' });

app.use(javaplayserver);
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
    this.res.writeHead(200, {'Content-type': 'text/plain'});
    this.res.end('tried login with no user');
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

function readLab(labName, callback) {
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) {
      callback(e);
      return;
    }
    var lab = JSON.parse(data);
    async.map(lab.parts, function(f, done) {
      fs.readFile(path.join('labs', labName, f), done);
    }, function(e, results) {
      if (e) {
        callback(e);
        return;
      }
      var parts = [];
      for (var i = 0; i < results.length; i++) {
        parts.push({'name': lab.parts[i], 'text': results[i]});
      }
      callback(null, parts);
    });
  });
}

var mongoServer = new mongo.Server('localhost', 27017, {auto_reconnect: true});
var mongoDb = new mongo.Db('javalab', mongoServer, {safe: true});

function openUserLabs(callback) {
  mongoDb.open(function(e, db) {
    if (e) { callback(e); return; }
    db.collection('userlabs', function(e, collection) {
      if (e) {
        db.close();
        callback(e);
        return;
      }
      callback(null, db, collection);
    });
  });
}

function readUserLab(user, labName, callback) {
  openUserLabs(function(e, db, collection) {
    if (e) { callback(e); return; }
    collection.findOne({user: user, labName: labName}, function(e, item) {
      db.close();
      if (e) { callback(e); return; }
      callback(null, item);
    });
  });
}

function createUserLab(user, labName, labParts, callback) {
  openUserLabs(function(e, db, collection) {
    if (e) { callback(e); return; }
    collection.insert(
      {user: user, labName: labName, labParts: labParts},
      {safe: true},
      function(e, result) {
        db.close();
        callback(e);
      });
  });
}

function updateUserLabParts(user, labName, labParts, callback) {
  openUserLabs(function(e, db, collection) {
    if (e) { callback(e); return; }
    collection.update(
      {user: user, labName: labName},
      {$set: {labParts: labParts}},
      {safe: true},
      function(e, result) {
        db.close();
        callback(e);
      });
  });
}

function populateDocs(user, labName, labParts, callback) {
  async.forEach(labParts, function(part, done) {
    var docName = user + ':' + labName + ':' + part.name;
    shareClient.open(
      docName,
      'text', 
      'http://localhost:' + app.config.get('httpPort') + '/channel',
      function(e, doc) {
        if (e) {
          done(e);
          return;
        }
        if (!doc.getText()) {
          doc.insert(0, String(part.text), function(e, appliedOp) {
            doc.close();
            done(e);
          });
        } else {
          doc.close();
          done();
        }
      });
  }, callback);
}

function failWithJson(info, errorText) {
  info.res.writeHead(200, {'Content-type': 'application/json'});
  info.res.end(JSON.stringify({error: errorText}));
}

app.router.post(/\/lab\/:lab\/parts\/:part/, function(lab, part) {
  var info = this;
  var user = info.req.session.user;
  if (user == null) return failWithJson(info, 'Not logged in');
  readUserLab(user, lab, function(e, item) {
    if (e || !item) return failWithJson(info, 'Failed to read lab for user');
    if (item.labParts.indexOf(part) != -1) {
      return failWithJson(info, 'Lab part already exists');
    }
    item.labParts.push(part);
    updateUserLabParts(user, lab, item.labParts, function(e) {
      if (e) return failWithJson(info, 'Failed to update lab for user');
      info.res.writeHead(200, {'Content-type': 'application/json'});
      info.res.end(JSON.stringify({}));
    });
  });
});

app.router.delete(/\/lab\/:lab\/parts\/:part/, function(lab, part) {
  var info = this;
  var user = info.req.session.user;
  if (user == null) return failWithJson(info, 'Not logged in');
  readUserLab(user, lab, function(e, item) {
    if (e || !item) return failWithJson(info, 'Failed to read lab for user');
    var pos = item.labParts.indexOf(part);
    if (pos == -1) return failWithJson(info, 'Lab does not have given part');
    item.labParts.splice(pos, 1);
    updateUserLabParts(user, lab, item.labParts, function(e) {
      if (e) return failWithJson(info, 'Failed to update lab for user');
      info.res.writeHead(200, {'Content-type': 'application/json'});
      info.res.end(JSON.stringify({}));
    });
  });
});

app.router.get(/\/lab\/:labName/, function(labName) {
  var info = this;
  var user = info.req.session.user;
  if (user == null){
    // if user is not logged-in redirect back to login page //
    info.res.redirect('/');
  } else {
    readUserLab(user, labName, function(e, item) {
      if (e) {
        info.res.writeHead(200, {'Content-type': 'text/plain'});
        info.res.end('MongoDB read failed for ' + user + ' ' + labName + '\n' +
                     String(e));
        return;
      }
      if (item) {
        render(item.labParts);
      } else {
        readLab(labName, function(e, labPartData) {
          if (e) {
            info.res.writeHead(200, {'Content-type': 'text/plain'});
            info.res.end('Failed to read lab ' + labName + '\n' + String(e));
            return;
          }
          var partNames = [];
          for (var i = 0; i < labPartData.length; i++) {
            partNames.push(labPartData[i].name);
          }
          createUserLab(user, labName, partNames, function(e) {
            if (e) {
              info.res.writeHead(200, {'Content-type': 'text/plain'});
              info.res.end('Failed to create lab item in DB\n' + String(e));
              return;
            }       
            populateDocs(user, labName, labPartData, function(e) {
              if (e) {
                info.res.writeHead(200, {'Content-type': 'text/plain'});
                info.res.end('Failed to populate docs\n' + String(e));
                return;
              }
              render(partNames);
            });
          });
        });
      }
    });
    function render(partNames) {
      var output = labTemplate({'user': user,
                                'labName': labName,
                                'partNames': partNames});
      info.res.writeHead(200, {'Content-type': 'text/html'});
      info.res.end(output);   
    }
  }   
});

app.start(app.config.get('httpPort'));         

