const GitRepository = require('./git-tools');
const YAML = require('yaml');
const path = require('path');
const fs = {
  ...require('fs'),
  ...require('fs-extra')
};
const d3Node = require('d3-node');

const DIVIDER = '-_-';

module.exports = {
  collect,
  clean,
  report
};

function getConfig() {
  const configPath = path.resolve(process.env.GIT_LOG_CONFIG_PATH || './git-log-config.yml');
  const file = fs.readFileSync(configPath, 'utf8');
  return YAML.parse(file);
}

function getRepositoryName(repository) {
  return repository.url.replace(/\W+/g, '-').toLowerCase();
}

function getUnusedUsers(config) {
  let usedUsers = [];
  for (let team of config.teams) {
    team.users = team.users || [];
    if (team.invert) {
      team.users = usedUsers;
    } else {
      usedUsers = [...usedUsers, ...team.users];
    }
  }
  return usedUsers;
}

function getBranchName(repository, config) {
  return repository.branch || config.branch || 'master';
}

async function collect() {
  const config = getConfig();
  getUnusedUsers(config);
  const tmpDir = path.resolve(config.tmpDir);
  fs.ensureDirSync(tmpDir);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      const repositoryPath = path.resolve(tmpDir, repositoryName);
      let pathExist = fs.existsSync(repositoryPath);
      let gitRepository = new GitRepository(repositoryPath);

      if (config.cleanTmp || repository.cleanTmp || (pathExist && !(await gitRepository.isRepo()))) {
        fs.removeSync(repositoryPath);
        pathExist = false;
      }

      if (!pathExist) {
        gitRepository = await GitRepository.clone({
          repo: repository.url,
          dir: repositoryPath,
          branch: getBranchName(repository, config)
        });
      }

      for (let team of config.teams) {
        const activeDays = await getActiveDays(gitRepository, repository, team, config);
        if (Object.keys(activeDays).length > 0) {
          const repositoryStatsFileName = `${repositoryName}${DIVIDER}${team.name}${DIVIDER}${Date.now().toString()}.json`;
          fs.writeFileSync(path.resolve(config.dataDir, repositoryStatsFileName), JSON.stringify(activeDays, null, 4));
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
}

function readStatsFolder(config) {
  let toRemove = [];
  const fileMap = {};
  for (let file of fs.readdirSync(config.dataDir)) {
    if (file.includes('.json') && file.includes(DIVIDER)) {
      let [repositoryName, team, timestamp] = file.split(DIVIDER);
      timestamp = Number.parseInt(timestamp, 10);
      const fileKey = repositoryName + DIVIDER + team;
      if (!fileMap[fileKey] || fileMap[fileKey].timestamp < timestamp) {
        if (fileMap[fileKey]) {
          toRemove.push(file);
        }
        fileMap[fileKey] = {
          repositoryName,
          file,
          team,
          timestamp
        };
      }
    }
  }
  return { fileMap, toRemove };
}

async function clean() {
  const config = getConfig();
  const { toRemove } = readStatsFolder(config);
  for (let file of toRemove) {
    fs.removeSync(file);
  }
}

async function report() {
  const config = getConfig();

  const dates = {};
  for (let team of config.teams) {
    dates[team.name] = {};
  }

  const { fileMap } = readStatsFolder(config);

  for (let repository of config.repositories) {
    try {
      const repositoryName = getRepositoryName(repository);
      for (let team of config.teams) {
        const fileKey = repositoryName + DIVIDER + team.name;
        if (fileMap[fileKey]) {
          const activeDays = JSON.parse(fs.readFileSync(path.resolve(config.dataDir, fileMap[fileKey].file), 'utf8'));
          for (let key in activeDays) {
            dates[team.name][key] = (dates[team.name][key] || 0) + activeDays[key];
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  for (let team of config.teams) {
    makeReport(dates[team.name], team, config);
  }
}

async function getActiveDays(gitRepository, repository, team, config) {
  return await gitRepository.activeDays((email, author) => {
    author = author.toLowerCase();
    email = email.toLowerCase();
    const includes = team.users.includes(author) || team.users.includes(email);
    const exclude = team.exclude && (team.exclude.includes(author) || team.exclude.includes(email));
    const excludeRepository = repository.exclude && (repository.exclude.includes(author) || repository.exclude.includes(email));
    return (team.invert ? !includes : includes) && (!team.exclude || !exclude) && (!repository.exclude || !excludeRepository);
  }, getBranchName(repository, config));
}

function makeReport(dates, team, config) {
  const output = path.resolve(config.outputDir, team.output);

  let data = [];

  for (let key in dates) {
    data.push({ Date: key, Value: dates[key] });
  }
  // data = require('./data');

  data = data.sort((a, b) => new Date(a.Date) - new Date(b.Date));

  let minYear = Infinity;
  let maxYear = 0;

  const checkYear = date => {
    const year = date.getFullYear();

    if (year > maxYear) {
      maxYear = year;
    }

    if (year < minYear) {
      minYear = year;
    }
  };

  const d3n = new d3Node();
  const d3 = d3n.d3;

  const dateValues = data.map(dv => {
    const date = new Date(dv.Date);
    checkYear(date);
    return {
      date: d3.timeDay(date),
      value: Number(dv.Value)
    };
  });

  if (maxYear === 0) {
    fs.removeSync(output);
    return;
  }

  const yearGap = Math.abs(maxYear - minYear);

  const cellSize = 15;
  const yearHeight = cellSize * 7;
  const marginTop = cellSize * 0.5;
  const marginLeft = 50;
  const marginRight = 10;
  const weeksInYear = 53;

  const [width, height] = [marginLeft + cellSize * (weeksInYear + 1) + marginRight, yearHeight * (yearGap + 1) + 2 * marginTop];
  
  const svg = d3n.createSVG(width, height);

  const years = d3
    .nest()
    .key(d => d.date.getUTCFullYear())
    .entries(dateValues)
    .reverse();

  const values = dateValues.map(c => c.value);
  const maxValue = d3.max(values);
  const minValue = d3.min(values);

  const group = svg.append('g');

  const year = group
    .selectAll('g')
    .data(years)
    .join('g')
    .attr('transform', (d, i) => `translate(${marginLeft}, ${yearHeight * i + marginTop})`);

  year
    .append('text')
    .attr('x', -5)
    .attr('y', -30)
    .attr('text-anchor', 'end')
    .attr('font-size', 16)
    .attr('font-weight', 550)
    .attr('font-family', 'Arial')
    .attr('transform', 'rotate(270)')
    .text(d => d.key);

  const formatDay = d => ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][d.getUTCDay()];
  const countDay = d => d.getUTCDay();
  const timeWeek = d3.utcSunday;
  const formatDate = d3.utcFormat('%x');
  const colorFn = d3.scaleSequential(d3.interpolateBuGn).domain([Math.floor(minValue), Math.ceil(maxValue)]);

  year
    .append('g')
    .attr('text-anchor', 'end')
    .selectAll('text')
    .data(d3.range(7).map(i => new Date(1995, 0, i)))
    .join('text')
    .attr('x', -5)
    .attr('y', d => (countDay(d) + 0.5) * cellSize)
    .attr('dy', '0.31em')
    .attr('font-size', 12)
    .text(formatDay);

  year
    .append('g')
    .selectAll('rect')
    .data(d => d.values)
    .join('rect')
    .attr('width', cellSize - 1.5)
    .attr('height', cellSize - 1.5)
    .attr('x', (d, i) => timeWeek.count(d3.utcYear(d.date), d.date) * cellSize + 10)
    .attr('y', d => countDay(d.date) * cellSize + 0.5)
    .attr('fill', d => colorFn(d.value))
    .append('title')
    .text(d => `${formatDate(d.date)}: ${d.value.toFixed(2)}`);

  fs.writeFileSync(output, d3n.svgString());
}

// const PDFDocument = require('pdfkit');

// const doc = new PDFDocument();
// const out = fs.createWriteStream('output.pdf');
// doc.pipe(out);

// const content = 'req.body.content';
// doc.y = 300;
// doc.text(content, 50, 50);

// doc.addPage()
//    .fontSize(25)
//    .text('Here is some vector graphics...', 100, 100);

// doc.image('path/to/image.png', {
//   fit: [250, 300],
//   align: 'center',
//   valign: 'center'
// });

// // Draw a triangle
// doc.save()
//    .moveTo(100, 150)
//    .lineTo(100, 250)
//    .lineTo(200, 250)
//    .fill("#FF3300");

// // Apply some transforms and render an SVG path with the 'even-odd' fill rule
// doc.scale(0.6)
//    .translate(470, -380)
//    .path('M 250,75 L 323,301 131,161 369,161 177,301 z')
//    .fill('red', 'even-odd')
//    .restore();

// Add some text with annotations
// doc.addPage()
//    .fillColor("blue")
//    .text('Here is a link!', 100, 100)
//    .underline(100, 100, 160, 27, {color: "#0000FF"})
//    .link(100, 100, 160, 27, 'http://google.com/');

// doc.end();
// out.on('finish', function() {
//   // what you want to do with the file.
// });
